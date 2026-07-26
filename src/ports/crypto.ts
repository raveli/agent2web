/**
 * Every cryptographic operation the app performs.
 *
 * The shared implementation (core/crypto.ts) uses WebCrypto, which both Node 22
 * and Cloudflare Workers provide. The Node driver extends it only to keep
 * verifying scrypt hashes written before the move to PBKDF2.
 */
export interface CryptoPort {
  /** Hashes a password for storage. Format is self-describing and versioned. */
  hashPassword(plaintext: string): Promise<string>;
  verifyPassword(plaintext: string, stored: string): Promise<boolean>;
  /** True when `stored` is a hash this runtime can actually verify. */
  canVerify(stored: string): boolean;

  /** Keyed hash used to store tokens and session ids at rest. base64url. */
  hmac(key: string, value: string): Promise<string>;
  /** Content hash for published files. Lowercase hex. */
  sha256Hex(data: Uint8Array): Promise<string>;

  randomToken(bytes?: number): string;
}
