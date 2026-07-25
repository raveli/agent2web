import { createHmac, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function decodeBase32(input: string): Buffer {
  const cleaned = input.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

function hotp(key: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

/**
 * Verifies a 6-digit TOTP code (RFC 6238, SHA-1, 30 s step) allowing one step of
 * clock drift in either direction.
 */
export function verifyTotp(base32Secret: string, code: string, now = Date.now()): boolean {
  const digits = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return false;
  let key: Buffer;
  try {
    key = decodeBase32(base32Secret);
  } catch {
    return false;
  }
  if (key.length === 0) return false;
  const counter = Math.floor(now / 1000 / 30);
  for (const drift of [-1, 0, 1]) {
    const expected = Buffer.from(hotp(key, counter + drift));
    const actual = Buffer.from(digits);
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) return true;
  }
  return false;
}
