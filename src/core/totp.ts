import { bytesEqual, utf8 } from '../util/bytes.js';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function decodeBase32(input: string): Uint8Array {
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
  return Uint8Array.from(out);
}

async function hotp(key: Uint8Array, counter: number): Promise<string> {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, BigInt(counter));
  const secret = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', secret, buf));
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
 *
 * SHA-1 is what every authenticator app implements, and WebCrypto still offers
 * it for exactly this kind of legacy interop.
 */
export async function verifyTotp(
  base32Secret: string,
  code: string,
  now = Date.now(),
): Promise<boolean> {
  const digits = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return false;
  let key: Uint8Array;
  try {
    key = decodeBase32(base32Secret);
  } catch {
    return false;
  }
  if (key.length === 0) return false;
  const counter = Math.floor(now / 1000 / 30);
  let matched = false;
  // Every candidate is checked so the work does not depend on which one matches.
  for (const drift of [-1, 0, 1]) {
    const expected = await hotp(key, counter + drift);
    if (bytesEqual(utf8(expected), utf8(digits))) matched = true;
  }
  return matched;
}
