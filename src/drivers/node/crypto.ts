import { scryptSync, timingSafeEqual } from 'node:crypto';
import { WebCryptoProvider, isLegacyScryptHash } from '../../core/crypto.js';
import { fromBase64Url } from '../../util/bytes.js';

/**
 * The shared WebCrypto provider plus the ability to verify scrypt hashes issued
 * before the move to PBKDF2.
 *
 * Cloudflare has no scrypt, so this back-compat exists on Node only. A Workers
 * deployment handed a scrypt hash refuses to start and says why, rather than
 * rejecting every correct password at the login form.
 */
export class NodeCryptoProvider extends WebCryptoProvider {
  override async verifyPassword(plaintext: string, stored: string): Promise<boolean> {
    if (isLegacyScryptHash(stored)) return verifyScrypt(plaintext, stored);
    return super.verifyPassword(plaintext, stored);
  }

  override canVerify(stored: string): boolean {
    return isLegacyScryptHash(stored) || super.canVerify(stored);
  }
}

function verifyScrypt(plaintext: string, stored: string): boolean {
  const separator = stored.includes('.') ? '.' : '$';
  const parts = stored.trim().split(separator);
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N < 2 || r < 1 || p < 1) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[4]!) || !/^[A-Za-z0-9_-]+$/.test(parts[5]!)) return false;

  const salt = Buffer.from(fromBase64Url(parts[4]!));
  const expected = Buffer.from(fromBase64Url(parts[5]!));
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const actual = scryptSync(plaintext.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: 64 * 1024 * 1024,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
