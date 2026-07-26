// Prints ready-to-paste secrets for a new deployment.
//
// Usage: npm run gen-secrets [-- <admin password>]
import { WebCryptoProvider } from '../build/src/core/crypto.js';

const crypto = new WebCryptoProvider();
const password = process.argv[2] ?? base58(18);

console.log(
  [
    '# agent2web secrets — set these on the Worker (dashboard → Settings → Variables)',
    '# or with: wrangler secret put <NAME>',
    `A2W_SECRET=${crypto.randomToken(48)}`,
    `A2W_API_TOKEN=${crypto.randomToken(32)}`,
    `A2W_ADMIN_PASSWORD_HASH=${await crypto.hashPassword(password)}`,
    '',
    `# Admin password (stored nowhere else — save it now): ${password}`,
    '# Optional: A2W_ADMIN_TOTP_SECRET, a base32 secret, to require a 6-digit code.',
  ].join('\n'),
);

function base58(length) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map(b => alphabet[b % alphabet.length]).join('');
}
