import { randomBytes } from 'node:crypto';
import { hashPassword, randomToken } from '../auth/passwords.js';

/**
 * Prints ready-to-paste secrets for a new deployment.
 *
 * Usage: npm run gen-secrets [-- <admin password>]
 * With no password argument a strong one is generated and printed.
 */
const provided = process.argv[2];
const password = provided ?? base58(18);

const lines = [
  '# agent2web secrets — copy into .env or your Kubernetes Secret',
  `A2W_SECRET=${randomToken(48)}`,
  `A2W_API_TOKEN=${randomToken(32)}`,
  `A2W_ADMIN_PASSWORD_HASH='${hashPassword(password)}'`,
  '',
  `# Admin password (not stored anywhere else — save it now): ${password}`,
  '# TOTP is optional: set A2W_ADMIN_TOTP_SECRET to a base32 secret to require a 6-digit code.',
];

console.log(lines.join('\n'));

function base58(length: number): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}
