import { bytesEqual, fromBase64Url, toBase64Url, toHex, utf8 } from '../util/bytes.js';

/**
 * Production Workers reject any single PBKDF2 derivation above this, with
 * `NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
 * supported`. Cloudflare's CPU limiter cannot interrupt BoringSSL mid-loop, so
 * it refuses the work up front instead.
 *
 * It is not a limit we can discover by testing: workerd dropped its own default
 * in commit 12bc98a9, so `wrangler dev`, Miniflare and the suite all run
 * uncapped and only the deployed enforcer objects. test/crypto.test.ts asserts
 * the ceiling directly for that reason.
 */
const MAX_ITERATIONS_PER_CALL = 100_000;

/**
 * OWASP's current floor for PBKDF2-SHA256 is 600,000 iterations, which is six
 * times what one call may ask for. So the work is chained: each round runs the
 * cap and feeds its output in as the next round's input, and a guess still
 * costs an attacker the full 600,000.
 */
const PBKDF2_CHUNK = MAX_ITERATIONS_PER_CALL;
const PBKDF2_ROUNDS = 6;
const KEY_BITS = 256;
const SALT_BYTES = 16;

/**
 * WebCrypto implementation shared by both runtimes.
 *
 * scrypt was the original choice but has no WebCrypto equivalent, so stored
 * hashes are tagged with their algorithm and cost:
 * `pbkdf2c.<chunk>.<rounds>.<salt>.<key>`. Both numbers are stored rather than
 * assumed so that a hash minted today still verifies if the constants move.
 * Dots rather than the conventional `$` because this value's usual home is an
 * environment variable, and `$` in an unquoted .env line gets expanded by the
 * shell into a corrupted hash that still looks plausible.
 */
export class WebCryptoProvider {
  async hashPassword(plaintext: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const key = await derive(plaintext, salt, PBKDF2_CHUNK, PBKDF2_ROUNDS);
    return ['pbkdf2c', PBKDF2_CHUNK, PBKDF2_ROUNDS, toBase64Url(salt), toBase64Url(key)].join('.');
  }

  async verifyPassword(plaintext: string, stored: string): Promise<boolean> {
    const parsed = parsePbkdf2(stored);
    if (!parsed) return false;
    const actual = await derive(
      plaintext,
      parsed.salt,
      parsed.chunk,
      parsed.rounds,
      parsed.key.length * 8,
    );
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

  /**
   * A password someone can read off a screen, say out loud and retype.
   *
   * Minted when a site is protected but nobody chose a password. The alphabet
   * omits l, o, 0 and 1 — the characters people transcribe wrongly — and is
   * exactly 32 long so that taking a byte modulo it introduces no bias. Four
   * groups of four is 20 bits shy of a 128-bit key and far beyond what the
   * per-site throttle will let anyone try.
   */
  readablePassword(groups = 4, size = 4): string {
    const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'; // 32 characters, no look-alikes
    const bytes = crypto.getRandomValues(new Uint8Array(groups * size));
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      if (i > 0 && i % size === 0) out += '-';
      out += alphabet[bytes[i]! % alphabet.length];
    }
    return out;
  }
}

/**
 * Runs `rounds` derivations of `chunk` iterations each, feeding every round's
 * output in as the next one's input, so the total cost is their product while
 * no single call exceeds what the runtime will accept.
 */
async function derive(
  plaintext: string,
  salt: Uint8Array,
  chunk: number,
  rounds: number,
  bits = KEY_BITS,
): Promise<Uint8Array> {
  let material: Uint8Array = utf8(plaintext.normalize('NFKC'));
  for (let round = 0; round < rounds; round++) {
    const key = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveBits']);
    const derived = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: chunk },
      key,
      bits,
    );
    material = new Uint8Array(derived);
  }
  return material;
}

export type Pbkdf2Hash = { chunk: number; rounds: number; salt: Uint8Array; key: Uint8Array };

export function parsePbkdf2(stored: string): Pbkdf2Hash | undefined {
  if (typeof stored !== 'string') return undefined;
  const parts = stored.trim().split('.');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2c') return undefined;
  const chunk = Number(parts[1]);
  const rounds = Number(parts[2]);
  // A chunk the runtime would refuse is not verifiable, and saying so here
  // turns it into a startup error naming the variable rather than a 500 at the
  // login form.
  if (!Number.isInteger(chunk) || chunk < 1000 || chunk > MAX_ITERATIONS_PER_CALL) return undefined;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 64) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[3]!) || !/^[A-Za-z0-9_-]+$/.test(parts[4]!)) return undefined;
  const salt = fromBase64Url(parts[3]!);
  const key = fromBase64Url(parts[4]!);
  if (salt.length === 0 || key.length === 0) return undefined;
  return { chunk, rounds, salt, key };
}

/**
 * True for the single-call `pbkdf2.<iterations>.…` format minted before the
 * Cloudflare cap was known. Those asked for 600,000 iterations at once, which
 * production refuses outright, so they can only be regenerated.
 */
export function isUncappedPbkdf2Hash(stored: string): boolean {
  if (typeof stored !== 'string') return false;
  const parts = stored.trim().split('.');
  return parts.length === 4 && parts[0] === 'pbkdf2';
}

/** True for the pre-PBKDF2 format, which only the Node driver can verify. */
export function isLegacyScryptHash(stored: string): boolean {
  if (typeof stored !== 'string') return false;
  const separator = stored.includes('.') ? '.' : '$';
  const parts = stored.trim().split(separator);
  return parts.length === 6 && parts[0] === 'scrypt';
}
