import express, { type Request, type Response } from 'express';
import type { Config } from '../config.js';
import type { SiteRow } from '../db.js';
import type { SiteStore } from '../storage.js';
import { Throttle } from '../auth/throttle.js';
import { verifyPassword } from '../auth/passwords.js';
import {
  issueSiteCookie,
  siteCookieName,
  siteCookieValid,
} from '../auth/session.js';
import { parseCookies, serializeCookie } from '../util/cookies.js';
import { siteCookiePath } from '../urls.js';
import { notFoundPage, sitePasswordPage } from './pages.js';
import type { Resolution } from './resolve.js';

export type SiteTarget = Extract<Resolution, { kind: 'site' }>;

const formParser = express.urlencoded({ extended: false, limit: '16kb' });

export class SiteServer {
  /** Failed password attempts per client IP + site. */
  readonly loginThrottle = new Throttle(10, 10 * 60_000);

  constructor(
    private readonly config: Config,
    private readonly store: SiteStore,
  ) {}

  handle(req: Request, res: Response, target: SiteTarget): void {
    const { site } = target;

    if (site.visibility === 'disabled') {
      this.sendNotFound(res, site, 404);
      return;
    }

    const inner = target.innerPath.split('?')[0] ?? '/';
    if (inner === '/__a2w/login' || inner === '/__a2w/logout') {
      this.handleAuthEndpoint(req, res, target, inner);
      return;
    }

    if (site.visibility === 'password' && !this.hasSiteAccess(req, site)) {
      this.sendPasswordPrompt(req, res, target);
      return;
    }

    const resolved = this.store.resolveRequest(site, inner);
    if (!resolved) {
      this.sendNotFound(res, site, 404);
      return;
    }

    this.applyHeaders(res, site, target, resolved.contentType);
    if (resolved.contentType.startsWith('text/html')) this.store.recordView(site.id);
    res.sendFile(resolved.absolute, { dotfiles: 'allow' }, err => {
      if (err && !res.headersSent) this.sendNotFound(res, site, 404);
    });
  }

  // ------------------------------------------------------------------ access

  private hasSiteAccess(req: Request, site: SiteRow): boolean {
    const cookies = parseCookies(req.headers.cookie);
    if (siteCookieValid(this.config.secret, site, cookies[siteCookieName(site.id)])) return true;
    return this.basicAuthMatches(req, site);
  }

  /** Accepts `curl -u :password` so protected sites stay scriptable. */
  private basicAuthMatches(req: Request, site: SiteRow): boolean {
    const header = req.headers.authorization;
    if (!header?.toLowerCase().startsWith('basic ') || !site.password_hash) return false;
    let decoded: string;
    try {
      decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    } catch {
      return false;
    }
    const password = decoded.slice(decoded.indexOf(':') + 1);
    return verifyPassword(password, site.password_hash);
  }

  private handleAuthEndpoint(
    req: Request,
    res: Response,
    target: SiteTarget,
    inner: string,
  ): void {
    const { site } = target;
    const cookiePath = siteCookiePath(this.config, site.slug, target.hostBased);

    if (inner === '/__a2w/logout') {
      res.setHeader(
        'Set-Cookie',
        serializeCookie(siteCookieName(site.id), '', {
          path: cookiePath,
          maxAgeSeconds: 0,
          secure: this.secureCookies(req),
        }),
      );
      res.redirect(302, `${target.basePath}/`);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (site.visibility !== 'password') {
        res.redirect(302, `${target.basePath}/`);
        return;
      }
      this.sendPasswordPrompt(req, res, target);
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).setHeader('Allow', 'GET, POST');
      res.end();
      return;
    }

    formParser(req, res, () => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const password = typeof body.password === 'string' ? body.password : '';
      const next = this.safeNext(target, typeof body.next === 'string' ? body.next : '');
      const key = `${this.clientIp(req)}:${site.id}`;

      const retryAfter = this.loginThrottle.check(key);
      if (retryAfter > 0) {
        res.status(429).setHeader('Retry-After', String(retryAfter));
        this.sendHtml(
          res,
          sitePasswordPage({
            title: site.title || site.slug,
            action: `${target.basePath}/__a2w/login`,
            next,
            error: `Too many attempts. Try again in ${retryAfter} seconds.`,
          }),
        );
        return;
      }

      if (!site.password_hash || !verifyPassword(password, site.password_hash)) {
        this.loginThrottle.fail(key);
        res.status(401);
        this.sendHtml(
          res,
          sitePasswordPage({
            title: site.title || site.slug,
            action: `${target.basePath}/__a2w/login`,
            next,
            error: 'Incorrect password.',
          }),
        );
        return;
      }

      this.loginThrottle.succeed(key);
      res.setHeader(
        'Set-Cookie',
        serializeCookie(
          siteCookieName(site.id),
          issueSiteCookie(this.config.secret, site, this.config.siteCookieTtlHours * 3600),
          {
            path: cookiePath,
            maxAgeSeconds: this.config.siteCookieTtlHours * 3600,
            secure: this.secureCookies(req),
            sameSite: 'Lax',
          },
        ),
      );
      res.redirect(303, next);
    });
  }

  private sendPasswordPrompt(req: Request, res: Response, target: SiteTarget): void {
    const next = this.safeNext(target, req.originalUrl);
    res.status(401);
    res.setHeader('Cache-Control', 'private, no-store');
    this.sendHtml(
      res,
      sitePasswordPage({
        title: target.site.title || target.site.slug,
        action: `${target.basePath}/__a2w/login`,
        next,
      }),
    );
  }

  /** Only allows redirect targets inside this site. */
  private safeNext(target: SiteTarget, candidate: string): string {
    const fallback = `${target.basePath}/`;
    if (!candidate.startsWith('/') || candidate.startsWith('//')) return fallback;
    if (candidate.includes('/__a2w/')) return fallback;
    if (target.hostBased) return candidate;
    return candidate.startsWith(`${target.basePath}/`) ? candidate : fallback;
  }

  // ----------------------------------------------------------------- headers

  private applyHeaders(
    res: Response,
    site: SiteRow,
    target: SiteTarget,
    contentType: string,
  ): void {
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    if (site.visibility === 'password') {
      res.setHeader('Cache-Control', 'private, no-store');
    } else if (contentType.startsWith('text/html')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=300');
    }

    const sandbox =
      this.config.siteSandbox === 'always' ||
      (this.config.siteSandbox === 'auto' && !target.hostBased);
    if (sandbox) {
      // Published pages served from the app's own origin get an opaque origin so
      // they cannot reach the admin session, the MCP endpoint or each other.
      res.setHeader(
        'Content-Security-Policy',
        'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-popups-to-escape-sandbox',
      );
    }
  }

  private sendNotFound(res: Response, site: SiteRow, status: number): void {
    const custom = site.visibility === 'disabled' ? undefined : this.store.notFoundPage(site);
    res.status(status);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (custom) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.sendFile(custom, err => {
        if (err && !res.headersSent) this.sendHtml(res, notFoundPage());
      });
      return;
    }
    this.sendHtml(res, notFoundPage());
  }

  private sendHtml(res: Response, html: string): void {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }

  private secureCookies(req: Request): boolean {
    return req.protocol === 'https' || this.config.publicOrigin.protocol === 'https:';
  }

  private clientIp(req: Request): string {
    return req.ip ?? req.socket.remoteAddress ?? 'unknown';
  }
}
