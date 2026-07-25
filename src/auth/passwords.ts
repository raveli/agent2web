import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 32;

/**
 * Hashes a password with scrypt from node:crypto — no native dependency, and
 * strong enough for the single-owner credentials this app protects.
 *
 * Format: `scrypt$N$r$p$<salt-b64>$<key-b64>`
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
  ].join('$');
}

export function verifyPassword(plaintext: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64url');
    expected = Buffer.from(parts[5]!, 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  let actual: Buffer;
  try {
    actual = scryptSync(plaintext.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: 64 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
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
