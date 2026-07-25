import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db, AdminSessionRow } from '../db.js';
import type { SiteRow } from '../db.js';
import { keyedHash, randomToken } from './passwords.js';

/** Appends an HMAC to a payload so it can be handed to a browser and trusted back. */
export function sign(secret: string, payload: string): string {
  const mac = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

export function unsign(secret: string, token: string): string | undefined {
  const index = token.lastIndexOf('.');
  if (index <= 0) return undefined;
  const payload = token.slice(0, index);
  const mac = token.slice(index + 1);
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  return payload;
}

export const siteCookieName = (siteId: string) => `a2w_site_${siteId}`;
export const ADMIN_COOKIE = 'a2w_admin';

/**
 * Fingerprint of the site's current credentials. Included in the site cookie so
 * that rotating or clearing the password invalidates cookies already issued.
 */
export function sitePasswordFingerprint(secret: string, site: SiteRow): string {
  return keyedHash(secret, `site:${site.id}:${site.password_hash ?? ''}`).slice(0, 16);
}

export function issueSiteCookie(secret: string, site: SiteRow, ttlSeconds: number): string {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  return sign(secret, `${expiresAt}.${sitePasswordFingerprint(secret, site)}`);
}

export function siteCookieValid(secret: string, site: SiteRow, cookie: string | undefined): boolean {
  if (!cookie) return false;
  const payload = unsign(secret, cookie);
  if (!payload) return false;
  const [expiresAt, fingerprint] = payload.split('.');
  if (!expiresAt || !fingerprint) return false;
  if (Number(expiresAt) * 1000 < Date.now()) return false;
  return fingerprint === sitePasswordFingerprint(secret, site);
}

// ------------------------------------------------------------- admin sessions

export function createAdminSession(
  db: Db,
  secret: string,
  ttlHours: number,
  label: string,
): string {
  const id = randomToken(32);
  const now = Date.now();
  db.prepare(
    'INSERT INTO admin_sessions (id_hash, label, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(keyedHash(secret, id), label.slice(0, 120), now, now + ttlHours * 3600_000);
  return id;
}

export function getAdminSession(
  db: Db,
  secret: string,
  id: string | undefined,
): AdminSessionRow | undefined {
  if (!id) return undefined;
  const row = db.prepare('SELECT * FROM admin_sessions WHERE id_hash = ?').get(keyedHash(secret, id)) as
    | AdminSessionRow
    | undefined;
  if (!row) return undefined;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM admin_sessions WHERE id_hash = ?').run(row.id_hash);
    return undefined;
  }
  return row;
}

export function destroyAdminSession(db: Db, secret: string, id: string | undefined): void {
  if (!id) return;
  db.prepare('DELETE FROM admin_sessions WHERE id_hash = ?').run(keyedHash(secret, id));
}

/** Deterministic per-session CSRF token, so forms need no server-side state. */
export function csrfToken(secret: string, sessionId: string): string {
  return keyedHash(secret, `csrf:${sessionId}`);
}

export function csrfValid(secret: string, sessionId: string, submitted: unknown): boolean {
  if (typeof submitted !== 'string' || submitted.length === 0) return false;
  const expected = Buffer.from(csrfToken(secret, sessionId));
  const actual = Buffer.from(submitted);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
