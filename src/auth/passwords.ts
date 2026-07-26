import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 32;

/**
 * Hashes a password with scrypt from node:crypto — no native dependency, and
 * strong enough for the single-owner credentials this app protects.
 *
 * Format: `scrypt.N.r.p.<salt-b64url>.<key-b64url>`
 *
 * Dots rather than the conventional `$` separators: this value's normal home is
 * an environment variable or a .env file, and `$` in an unquoted .env line gets
 * expanded by the shell into a corrupted hash that still looks plausible.
 * base64url never produces a dot, so the encoding stays unambiguous.
 */
export function hashPassword(plaintext: string, salt = randomBytes(16)): string {
  const key = scryptSync(plaintext.normalize('NFKC'), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_r,
    SCRYPT_p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('.');
}

export type ScryptHash = { N: number; r: number; p: number; salt: Buffer; key: Buffer };

/**
 * Parses a stored hash, returning undefined when it is not one. Also accepts the
 * older `$`-separated form so hashes generated before the switch keep working.
 */
export function parseScryptHash(stored: string): ScryptHash | undefined {
  if (typeof stored !== 'string') return undefined;
  const separator = stored.includes('.') ? '.' : '$';
  const parts = stored.trim().split(separator);
  if (parts.length !== 6 || parts[0] !== 'scrypt') return undefined;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return undefined;
  if (N < 2 || r < 1 || p < 1) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[4]!) || !/^[A-Za-z0-9_-]+$/.test(parts[5]!)) return undefined;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const key = Buffer.from(parts[5]!, 'base64url');
  if (salt.length === 0 || key.length === 0) return undefined;
  return { N, r, p, salt, key };
}

export function isValidPasswordHash(stored: string): boolean {
  return parseScryptHash(stored) !== undefined;
}

export function verifyPassword(plaintext: string, stored: string): boolean {
  const parsed = parseScryptHash(stored);
  if (!parsed) return false;
  let actual: Buffer;
  try {
    actual = scryptSync(plaintext.normalize('NFKC'), parsed.salt, parsed.key.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: 64 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  return actual.length === parsed.key.length && timingSafeEqual(actual, parsed.key);
}

/** Constant-time comparison of two secrets of arbitrary length. */
export function secretEquals(a: string, b: string): boolean {
  const ha = createHmac('sha256', 'compare').update(a).digest();
  const hb = createHmac('sha256', 'compare').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Generates a URL-safe random secret (32 bytes of entropy by default). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Keyed hash used to store tokens, authorization codes and session ids at rest.
 * Keying with the app secret means a stolen database alone cannot be replayed.
 */
export function keyedHash(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}
