import type { Context } from 'hono';
import type { Env } from './app.js';
import type { SiteRow } from '../store.js';
import type { Resolution } from '../core/resolve.js';
import { issueSiteCookie, siteCookieName, siteCookieValid } from '../core/session.js';
import { sitePasswordPage, notFoundPage } from '../core/views/pages.js';
import { siteCookiePath } from '../core/urls.js';
import { fromBase64 } from '../util/bytes.js';

type SiteTarget = Extract<Resolution, { kind: 'site' }>;

/**
 * Serves a published site: access gate first, then the object from R2.
 */
export async function serveSite(c: Context<Env>, target: SiteTarget): Promise<Response> {
  const { store, config, crypto, throttles } = c.var;
  const { site } = target;

  if (site.visibility === 'disabled') return notFound(c, target);

  const inner = target.innerPath.split('?')[0] ?? '/';
  if (inner === '/__a2w/login' || inner === '/__a2w/logout') {
    return handleAuthEndpoint(c, target, inner);
  }

  if (site.visibility === 'password' && !(await hasAccess(c, site))) {
    return passwordPrompt(c, target, 401);
  }

  const resolved = await store.resolveRequest(site, inner);
  if (!resolved) return notFound(c, target);

  const object = await store.openBlob(resolved.key);
  if (!object) return notFound(c, target);

  const headers = siteHeaders(config, site, target, resolved.contentType);
  headers.set('ETag', object.httpEtag);

  // Conditional request: the client already has this exact object.
  const ifNoneMatch = c.req.header('if-none-match');
  if (ifNoneMatch && ifNoneMatch.split(',').some(tag => tag.trim() === object.httpEtag)) {
    return new Response(null, { status: 304, headers });
  }

  if (resolved.contentType.startsWith('text/html')) {
    // Counting a view must not sit in the response path.
    c.executionCtx.waitUntil(store.recordView(site.id));
  }
  if (c.req.method === 'HEAD') {
    headers.set('Content-Length', String(object.size));
    return new Response(null, { status: 200, headers });
  }
  return new Response(object.body as unknown as ReadableStream, { status: 200, headers });
}

// ------------------------------------------------------------------- access

async function hasAccess(c: Context<Env>, site: SiteRow): Promise<boolean> {
  const { config, crypto } = c.var;
  const cookie = getCookie(c, siteCookieName(site.id));
  if (await siteCookieValid(crypto, config.secret, site, cookie)) return true;

  // `curl -u :password` keeps protected sites scriptable.
  const header = c.req.header('authorization');
  if (!header?.toLowerCase().startsWith('basic ') || !site.password_hash) return false;
  let decoded: string;
  try {
    decoded = new TextDecoder().decode(fromBase64(header.slice(6).trim()));
  } catch {
    return false;
  }
  return crypto.verifyPassword(decoded.slice(decoded.indexOf(':') + 1), site.password_hash);
}

async function handleAuthEndpoint(
  c: Context<Env>,
  target: SiteTarget,
  inner: string,
): Promise<Response> {
  const { config, crypto, throttles } = c.var;
  const { site } = target;
  const cookiePath = siteCookiePath(config, site.slug, target.hostBased);

  if (inner === '/__a2w/logout') {
    const headers = new Headers({ Location: `${target.basePath}/` });
    headers.append(
      'Set-Cookie',
      cookie(siteCookieName(site.id), '', { path: cookiePath, maxAge: 0, secure: isSecure(c) }),
    );
    return new Response(null, { status: 302, headers });
  }

  if (c.req.method === 'GET' || c.req.method === 'HEAD') {
    if (site.visibility !== 'password') {
      return c.redirect(`${target.basePath}/`, 302);
    }
    return passwordPrompt(c, target, 200);
  }
  if (c.req.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
  }

  const form = await c.req.formData();
  const password = String(form.get('password') ?? '');
  const next = safeNext(target, String(form.get('next') ?? ''));
  const key = `${clientIp(c)}:${site.id}`;

  const retryAfter = await throttles.site.check(key);
  if (retryAfter > 0) {
    return html(
      sitePasswordPage({
        title: site.title || site.slug,
        action: `${target.basePath}/__a2w/login`,
        next,
        error: `Too many attempts. Try again in ${retryAfter} seconds.`,
      }),
      429,
      { 'Retry-After': String(retryAfter) },
    );
  }

  if (!site.password_hash || !(await crypto.verifyPassword(password, site.password_hash))) {
    await throttles.site.fail(key);
    return html(
      sitePasswordPage({
        title: site.title || site.slug,
        action: `${target.basePath}/__a2w/login`,
        next,
        error: 'Incorrect password.',
      }),
      401,
    );
  }

  await throttles.site.succeed(key);
  const headers = new Headers({ Location: next });
  headers.append(
    'Set-Cookie',
    cookie(
      siteCookieName(site.id),
      await issueSiteCookie(crypto, config.secret, site, config.siteCookieTtlHours * 3600),
      {
        path: cookiePath,
        maxAge: config.siteCookieTtlHours * 3600,
        secure: isSecure(c),
        sameSite: 'Lax',
      },
    ),
  );
  return new Response(null, { status: 303, headers });
}

function passwordPrompt(c: Context<Env>, target: SiteTarget, status: 200 | 401): Response {
  const next = safeNext(target, new URL(c.req.url).pathname + new URL(c.req.url).search);
  return html(
    sitePasswordPage({
      title: target.site.title || target.site.slug,
      action: `${target.basePath}/__a2w/login`,
      next,
    }),
    status,
    { 'Cache-Control': 'private, no-store' },
  );
}

/** Only allows redirect targets inside this site. */
function safeNext(target: SiteTarget, candidate: string): string {
  const fallback = `${target.basePath}/`;
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return fallback;
  // Browsers normalise backslashes to slashes, so "/\evil.example" would leave
  // the origin exactly like "//evil.example" does.
  if (candidate.includes('\\')) return fallback;
  if (candidate.includes('/__a2w/')) return fallback;
  if (target.hostBased) return candidate;
  return candidate.startsWith(`${target.basePath}/`) ? candidate : fallback;
}

// ------------------------------------------------------------------ headers

function siteHeaders(
  config: Context<Env>['var']['config'],
  site: SiteRow,
  target: SiteTarget,
  contentType: string,
): Headers {
  const headers = new Headers({
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });

  if (site.visibility === 'password') {
    headers.set('Cache-Control', 'private, no-store');
  } else if (contentType.startsWith('text/html')) {
    headers.set('Cache-Control', 'no-cache');
  } else {
    headers.set('Cache-Control', 'public, max-age=300');
  }

  const sandbox =
    config.siteSandbox === 'always' || (config.siteSandbox === 'auto' && !target.hostBased);
  if (sandbox) {
    // Published pages served from the app's own origin get an opaque origin, so
    // they cannot reach the admin session, the MCP endpoint or each other.
    headers.set(
      'Content-Security-Policy',
      'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-popups-to-escape-sandbox',
    );
  }
  return headers;
}

/**
 * A site's own 404.html is user content, so it goes out with the same headers
 * (sandbox CSP included) as any other page from that site.
 */
async function notFound(c: Context<Env>, target: SiteTarget): Promise<Response> {
  const { store, config } = c.var;
  const { site } = target;
  const custom = site.visibility === 'disabled' ? undefined : await store.notFoundPage(site);
  if (custom) {
    const object = await store.openBlob(custom.key);
    if (object) {
      const headers = siteHeaders(config, site, target, custom.contentType);
      return new Response(object.body as unknown as ReadableStream, { status: 404, headers });
    }
  }
  return html(notFoundPage(), 404, { 'X-Content-Type-Options': 'nosniff' });
}

// ------------------------------------------------------------------- shared

export function html(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...extra },
  });
}

export function getCookie(c: Context<Env>, name: string): string | undefined {
  const header = c.req.header('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

export function cookie(
  name: string,
  value: string,
  options: {
    path?: string;
    maxAge?: number;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
  } = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? '/'}`];
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
    parts.push(`Expires=${new Date(Date.now() + options.maxAge * 1000).toUTCString()}`);
  }
  parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}

export function isSecure(c: Context<Env>): boolean {
  return (
    new URL(c.req.url).protocol === 'https:' ||
    c.var.config.publicOrigin.protocol === 'https:' ||
    c.req.header('x-forwarded-proto') === 'https'
  );
}

export function clientIp(c: Context<Env>): string {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}
