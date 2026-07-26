import express, { Router, type Request, type Response, type NextFunction } from 'express';
import type { Config } from '../config.js';
import type { Db, OAuthClientRow } from '../db.js';
import type { SiteStore, Visibility } from '../storage.js';
import { clientIp, verifyOwner } from '../auth/owner.js';
import {
  ADMIN_COOKIE,
  createAdminSession,
  csrfToken,
  csrfValid,
  destroyAdminSession,
  getAdminSession,
} from '../auth/session.js';
import { Throttle } from '../auth/throttle.js';
import { parseCookies, serializeCookie } from '../util/cookies.js';
import { messageFor } from '../util/errors.js';
import {
  adminLoginPage,
  connectionsPage,
  siteDetailPage,
  sitesPage,
  type ConnectionEntry,
  type SiteListEntry,
} from './views.js';

const formParser = express.urlencoded({ extended: false, limit: '16kb' });

/**
 * Minimal server-rendered admin UI: list sites, change access, set a custom
 * domain, roll back or delete, and revoke OAuth connections. Everything is
 * behind the owner password; every mutation carries a CSRF token.
 */
export function createAdminRouter(
  config: Config,
  db: Db,
  store: SiteStore,
  throttle: Throttle,
): Router {
  const router = Router();
  const secure = config.publicOrigin.protocol === 'https:';

  const currentSession = (req: Request) => {
    const id = parseCookies(req.headers.cookie)[ADMIN_COOKIE];
    const row = getAdminSession(db, config.secret, id);
    return row && id ? { id, row } : undefined;
  };

  router.get('/login', (req, res) => {
    if (currentSession(req)) {
      res.redirect(302, '/admin');
      return;
    }
    res.status(200).send(adminLoginPage(config, undefined, safeNext(req.query.next)));
  });

  router.post('/login', formParser, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const next = safeNext(body.next);
    const outcome = verifyOwner(config, throttle, clientIp(req), body.password, body.totp);
    if (!outcome.ok) {
      res.status(outcome.status).send(adminLoginPage(config, outcome.error, next));
      return;
    }
    const id = createAdminSession(db, config.secret, config.adminSessionTtlHours, 'admin-ui');
    res.setHeader(
      'Set-Cookie',
      serializeCookie(ADMIN_COOKIE, id, {
        path: '/',
        maxAgeSeconds: config.adminSessionTtlHours * 3600,
        secure,
        sameSite: 'Lax',
      }),
    );
    res.redirect(303, next);
  });

  // Everything below requires a session.
  const requireSession = (req: Request, res: Response, next: NextFunction) => {
    const session = currentSession(req);
    if (!session) {
      res.redirect(302, `/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    res.locals.sessionId = session.id;
    next();
  };

  const requireCsrf = (req: Request, res: Response, next: NextFunction) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!csrfValid(config.secret, res.locals.sessionId as string, body.csrf)) {
      res.status(403).send('Invalid CSRF token. Reload the admin page and try again.');
      return;
    }
    next();
  };

  router.post('/logout', requireSession, formParser, requireCsrf, (req, res) => {
    destroyAdminSession(db, config.secret, res.locals.sessionId as string);
    res.setHeader(
      'Set-Cookie',
      serializeCookie(ADMIN_COOKIE, '', { path: '/', maxAgeSeconds: 0, secure }),
    );
    res.redirect(303, '/admin/login');
  });

  router.get('/', requireSession, (req, res) => {
    const { rows } = store.listSites(200, 0);
    const entries: SiteListEntry[] = rows.map(site => {
      const versions = store.listVersions(site.id, 1000);
      const current = versions.find(v => v.id === site.current_version_id);
      return { site, versionCount: versions.length, bytes: current?.bytes ?? 0 };
    });
    res.status(200).send(
      sitesPage(config, entries, csrfToken(config.secret, res.locals.sessionId as string), flash(req)),
    );
  });

  router.get('/sites/:slug', requireSession, (req, res) => {
    const site = store.getSiteBySlug(String(req.params.slug));
    if (!site) {
      res.redirect(303, `/admin?err=${encodeURIComponent(`No site called "${req.params.slug}".`)}`);
      return;
    }
    res.status(200).send(
      siteDetailPage(
        config,
        {
          site,
          versions: store.listVersions(site.id, 1000),
          files: site.current_version_id ? store.listFiles(site.current_version_id) : [],
        },
        csrfToken(config.secret, res.locals.sessionId as string),
        flash(req),
      ),
    );
  });

  router.get('/connections', requireSession, (req, res) => {
    const clients = db
      .prepare('SELECT * FROM oauth_clients ORDER BY created_at DESC')
      .all() as OAuthClientRow[];
    const now = Date.now();
    const entries: ConnectionEntry[] = clients.map(client => {
      const metadata = JSON.parse(client.metadata) as {
        client_name?: string;
        redirect_uris?: string[];
      };
      const counts = db
        .prepare(
          `SELECT kind, COUNT(*) AS n, MAX(created_at) AS last FROM oauth_tokens
            WHERE client_id = ? AND revoked = 0 AND expires_at > ? GROUP BY kind`,
        )
        .all(client.client_id, now) as { kind: string; n: number; last: number }[];
      const access = counts.find(c => c.kind === 'access');
      const refresh = counts.find(c => c.kind === 'refresh');
      return {
        client,
        name: metadata.client_name ?? client.client_id,
        redirectUris: metadata.redirect_uris ?? [],
        activeAccessTokens: access?.n ?? 0,
        activeRefreshTokens: refresh?.n ?? 0,
        lastIssuedAt: Math.max(access?.last ?? 0, refresh?.last ?? 0) || null,
      };
    });
    res.status(200).send(
      connectionsPage(
        config,
        entries,
        csrfToken(config.secret, res.locals.sessionId as string),
        flash(req),
      ),
    );
  });

  /**
   * Wraps a mutation so it always lands back on a page with a message. Handlers
   * return where to go next, which is the site's own page unless the site is
   * gone by then.
   */
  const action = (handler: (req: Request) => { message: string; to: string }) => [
    requireSession,
    formParser,
    requireCsrf,
    (req: Request, res: Response) => {
      try {
        const { message, to } = handler(req);
        res.redirect(303, `${to}?ok=${encodeURIComponent(message)}`);
      } catch (err) {
        const back = `/admin/sites/${encodeURIComponent(String(req.params.slug))}`;
        res.redirect(303, `${back}?err=${encodeURIComponent(messageFor(err))}`);
      }
    },
  ];

  const sitePath = (slug: string) => `/admin/sites/${encodeURIComponent(slug)}`;

  router.post(
    '/sites/:slug/access',
    ...action(req => {
      const body = req.body as Record<string, unknown>;
      const visibility = String(body.visibility ?? 'public') as Visibility;
      const password = typeof body.password === 'string' && body.password ? body.password : null;
      const site = store.setAccess(String(req.params.slug), visibility, password);
      const message =
        site.visibility === 'password'
          ? password
            ? 'Password saved. Anyone who unlocked the site with the old one has to enter the new one.'
            : 'Visitors now need the password.'
          : site.visibility === 'disabled'
            ? 'The site now returns 404. Its files are kept.'
            : 'Anyone with the link can now see the site.';
      return { message, to: sitePath(site.slug) };
    }),
  );

  router.post(
    '/sites/:slug/domain',
    ...action(req => {
      const body = req.body as Record<string, unknown>;
      const domain = typeof body.domain === 'string' && body.domain.trim() ? body.domain.trim() : null;
      const site = store.setDomain(String(req.params.slug), domain);
      return {
        message: site.custom_domain
          ? `Answering for ${site.custom_domain}. Point its DNS at this server and add the host to your ingress.`
          : 'Custom domain removed.',
        to: sitePath(site.slug),
      };
    }),
  );

  router.post(
    '/sites/:slug/rollback',
    ...action(req => {
      const body = req.body as Record<string, unknown>;
      const { site, version } = store.rollback(String(req.params.slug), String(body.version_id ?? ''));
      return {
        message: `Now serving the version published ${new Date(version.created_at).toISOString().slice(0, 16).replace('T', ' ')}Z.`,
        to: sitePath(site.slug),
      };
    }),
  );

  router.post(
    '/sites/:slug/delete',
    ...action(req => {
      const site = store.deleteSite(String(req.params.slug));
      return { message: `Deleted ${site.slug}.`, to: '/admin' };
    }),
  );

  router.post('/connections/:clientId/revoke', requireSession, formParser, requireCsrf, (req, res) => {
    const clientId = String(req.params.clientId);
    const tx = db.transaction(() => {
      db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE client_id = ?').run(clientId);
      db.prepare('DELETE FROM oauth_codes WHERE client_id = ?').run(clientId);
      db.prepare('DELETE FROM oauth_auth_requests WHERE client_id = ?').run(clientId);
      db.prepare('DELETE FROM oauth_clients WHERE client_id = ?').run(clientId);
    });
    tx();
    res.redirect(303, '/admin/connections?ok=Connection+revoked');
  });

  return router;
}

function safeNext(value: unknown): string {
  if (typeof value !== 'string') return '/admin';
  // Backslashes are normalised to slashes by browsers, so they can escape the
  // origin the same way a leading "//" does.
  if (!value.startsWith('/admin') || value.startsWith('//') || value.includes('\\')) return '/admin';
  return value;
}

function flash(req: Request): { ok?: string; err?: string } {
  const ok = typeof req.query.ok === 'string' ? req.query.ok.slice(0, 300) : undefined;
  const err = typeof req.query.err === 'string' ? req.query.err.slice(0, 300) : undefined;
  return { ok, err };
}
