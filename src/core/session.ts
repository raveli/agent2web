import type { Config } from './config.js';
import type { WebCryptoProvider } from '../core/crypto.js';
import type { Sql } from '../d1.js';
import type { SiteRow } from '../store.js';
import { stringsEqual } from '../util/bytes.js';

export const ADMIN_COOKIE = 'a2w_admin';
export const siteCookieName = (siteId: string) => `a2w_site_${siteId}`;

export type AdminSessionRow = {
  id_hash: string;
  label: string;
  created_at: number;
  expires_at: number;
};

/** Appends an HMAC to a payload so it can be handed to a browser and trusted back. */
export async function sign(crypto: WebCryptoProvider, secret: string, payload: string): Promise<string> {
  return `${payload}.${await crypto.hmac(secret, payload)}`;
}

export async function unsign(
  crypto: WebCryptoProvider,
  secret: string,
  token: string,
): Promise<string | undefined> {
  const index = token.lastIndexOf('.');
  if (index <= 0) return undefined;
  const payload = token.slice(0, index);
  const expected = await crypto.hmac(secret, payload);
  return stringsEqual(token.slice(index + 1), expected) ? payload : undefined;
}

/**
 * Fingerprint of the site's current credentials, included in the site cookie so
 * that rotating or clearing the password invalidates cookies already issued.
 */
function fingerprint(crypto: WebCryptoProvider, secret: string, site: SiteRow): Promise<string> {
  return crypto
    .hmac(secret, `site:${site.id}:${site.password_hash ?? ''}`)
    .then((value: string) => value.slice(0, 16));
}

export async function issueSiteCookie(
  crypto: WebCryptoProvider,
  secret: string,
  site: SiteRow,
  ttlSeconds: number,
): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  return sign(crypto, secret, `${expiresAt}.${await fingerprint(crypto, secret, site)}`);
}

export async function siteCookieValid(
  crypto: WebCryptoProvider,
  secret: string,
  site: SiteRow,
  cookie: string | undefined,
): Promise<boolean> {
  if (!cookie) return false;
  const payload = await unsign(crypto, secret, cookie);
  if (!payload) return false;
  const [expiresAt, mark] = payload.split('.');
  if (!expiresAt || !mark) return false;
  if (Number(expiresAt) * 1000 < Date.now()) return false;
  return mark === (await fingerprint(crypto, secret, site));
}

// ------------------------------------------------------------- admin sessions

export async function createAdminSession(
  sql: Sql,
  crypto: WebCryptoProvider,
  config: Config,
  label: string,
): Promise<string> {
  const id = crypto.randomToken(32);
  const now = Date.now();
  await sql.run(
    'INSERT INTO admin_sessions (id_hash, label, created_at, expires_at) VALUES (?, ?, ?, ?)',
    await crypto.hmac(config.secret, id),
    label.slice(0, 120),
    now,
    now + config.adminSessionTtlHours * 3600_000,
  );
  return id;
}

export async function getAdminSession(
  sql: Sql,
  crypto: WebCryptoProvider,
  secret: string,
  id: string | undefined,
): Promise<AdminSessionRow | undefined> {
  if (!id) return undefined;
  const hash = await crypto.hmac(secret, id);
  const row = await sql.first<AdminSessionRow>(
    'SELECT * FROM admin_sessions WHERE id_hash = ?',
    hash,
  );
  if (!row) return undefined;
  if (row.expires_at < Date.now()) {
    await sql.run('DELETE FROM admin_sessions WHERE id_hash = ?', hash);
    return undefined;
  }
  return row;
}

export async function destroyAdminSession(
  sql: Sql,
  crypto: WebCryptoProvider,
  secret: string,
  id: string | undefined,
): Promise<void> {
  if (!id) return;
  await sql.run('DELETE FROM admin_sessions WHERE id_hash = ?', await crypto.hmac(secret, id));
}

/** Deterministic per-session CSRF token, so forms need no server-side state. */
export function csrfToken(crypto: WebCryptoProvider, secret: string, sessionId: string): Promise<string> {
  return crypto.hmac(secret, `csrf:${sessionId}`);
}

export async function csrfValid(
  crypto: WebCryptoProvider,
  secret: string,
  sessionId: string,
  submitted: unknown,
): Promise<boolean> {
  if (typeof submitted !== 'string' || submitted.length === 0) return false;
  return stringsEqual(submitted, await csrfToken(crypto, secret, sessionId));
}
