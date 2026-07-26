import type { CryptoPort } from '../ports/crypto.js';
import { bytesEqual, fromBase64Url, toBase64Url, toHex, utf8 } from '../util/bytes.js';

/**
 * OWASP's current floor for PBKDF2-SHA256. Measured at roughly 120 ms, which is
 * comfortable inside the Workers Paid CPU budget (30 s) and impossible inside
 * the Free one (10 ms) — see docs/local-testing.html and the deployment notes.
 */
const PBKDF2_ITERATIONS = 600_000;
const KEY_BITS = 256;
const SALT_BYTES = 16;

/**
 * WebCrypto implementation shared by both runtimes.
 *
 * scrypt was the original choice but has no WebCrypto equivalent, so stored
 * hashes are tagged with their algorithm: `pbkdf2.<iterations>.<salt>.<key>`.
 * Dots rather than the conventional `$` because this value's usual home is an
 * environment variable, and `$` in an unquoted .env line gets expanded by the
 * shell into a corrupted hash that still looks plausible.
 */
export class WebCryptoProvider implements CryptoPort {
  async hashPassword(plaintext: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const key = await derive(plaintext, salt, PBKDF2_ITERATIONS);
    return ['pbkdf2', PBKDF2_ITERATIONS, toBase64Url(salt), toBase64Url(key)].join('.');
  }

  async verifyPassword(plaintext: string, stored: string): Promise<boolean> {
    const parsed = parsePbkdf2(stored);
    if (!parsed) return false;
    const actual = await derive(plaintext, parsed.salt, parsed.iterations, parsed.key.length * 8);
    return bytesEqual(actual, parsed.key);
  }

  canVerify(stored: string): boolean {
    return parsePbkdf2(stored) !== undefined;
  }

  async hmac(key: string, value: string): Promise<string> {
    const secret = await crypto.subtle.importKey(
      'raw',
      utf8(key),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', secret, utf8(value));
    return toBase64Url(new Uint8Array(mac));
  }

  async sha256Hex(data: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', data);
    return toHex(new Uint8Array(digest));
  }

  async sha256Base64Url(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', utf8(value));
    return toBase64Url(new Uint8Array(digest));
  }

  randomToken(bytes = 32): string {
    return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
  }
}

async function derive(
  plaintext: string,
  salt: Uint8Array,
  iterations: number,
  bits = KEY_BITS,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    utf8(plaintext.normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations },
    key,
    bits,
  );
  return new Uint8Array(derived);
}

export type Pbkdf2Hash = { iterations: number; salt: Uint8Array; key: Uint8Array };

export function parsePbkdf2(stored: string): Pbkdf2Hash | undefined {
  if (typeof stored !== 'string') return undefined;
  const parts = stored.trim().split('.');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return undefined;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1000) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[2]!) || !/^[A-Za-z0-9_-]+$/.test(parts[3]!)) return undefined;
  const salt = fromBase64Url(parts[2]!);
  const key = fromBase64Url(parts[3]!);
  if (salt.length === 0 || key.length === 0) return undefined;
  return { iterations, salt, key };
}

/** True for the pre-PBKDF2 format, which only the Node driver can verify. */
export function isLegacyScryptHash(stored: string): boolean {
  if (typeof stored !== 'string') return false;
  const separator = stored.includes('.') ? '.' : '$';
  const parts = stored.trim().split(separator);
  return parts.length === 6 && parts[0] === 'scrypt';
}
