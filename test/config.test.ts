import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ConfigError, loadConfig } from '../src/config.js';
import { hashPassword, verifyPassword } from '../src/auth/passwords.js';
import { verifyTotp } from '../src/auth/totp.js';
import { Throttle } from '../src/auth/throttle.js';

const base = {
  A2W_PUBLIC_URL: 'https://a2w.example.com',
  A2W_SECRET: 'x'.repeat(40),
  A2W_ADMIN_PASSWORD_HASH: hashPassword('a-good-admin-password'),
} as NodeJS.ProcessEnv;

test('valid configuration is normalised', () => {
  const config = loadConfig({ ...base, A2W_PUBLIC_URL: 'https://a2w.example.com/' }, hashPassword);
  assert.equal(config.publicUrl, 'https://a2w.example.com');
  assert.equal(config.mcpUrl, 'https://a2w.example.com/mcp');
  assert.equal(config.sitesPathPrefix, '/s');
  assert.equal(config.dataDir, '/data');
  assert.equal(config.port, 8080);
  assert.equal(config.keepVersions, 10);
  assert.deepEqual(config.warnings, []);
});

test('missing or weak required values fail fast with a readable message', () => {
  assert.throws(() => loadConfig({} as NodeJS.ProcessEnv, hashPassword), ConfigError);
  assert.throws(
    () => loadConfig({ ...base, A2W_SECRET: 'too-short' }, hashPassword),
    /at least 32 characters/,
  );
  assert.throws(
    () => loadConfig({ ...base, A2W_PUBLIC_URL: 'a2w.example.com' }, hashPassword),
    /must be an origin/,
  );
  assert.throws(
    () => loadConfig({ ...base, A2W_PUBLIC_URL: 'https://a2w.example.com/base' }, hashPassword),
    /no path/,
  );
  const { A2W_ADMIN_PASSWORD_HASH: _omit, ...noHash } = base as Record<string, string>;
  assert.throws(() => loadConfig(noHash as NodeJS.ProcessEnv, hashPassword), /A2W_ADMIN_PASSWORD_HASH/);
  assert.throws(
    () => loadConfig({ ...noHash, A2W_ADMIN_PASSWORD: 'short' } as NodeJS.ProcessEnv, hashPassword),
    /at least 12 characters/,
  );
  assert.throws(() => loadConfig({ ...base, A2W_API_TOKEN: 'short-token' }, hashPassword), /A2W_API_TOKEN/);
});

test('a plaintext admin password is accepted but warned about', () => {
  const { A2W_ADMIN_PASSWORD_HASH: _omit, ...noHash } = base as Record<string, string>;
  const config = loadConfig(
    { ...noHash, A2W_ADMIN_PASSWORD: 'a-long-enough-password' } as NodeJS.ProcessEnv,
    hashPassword,
  );
  assert.ok(verifyPassword('a-long-enough-password', config.adminPasswordHash));
  assert.match(config.warnings.join(' '), /plaintext/);
});

test('http public URLs and shared site domains raise warnings', () => {
  const insecure = loadConfig({ ...base, A2W_PUBLIC_URL: 'http://a2w.example.com' }, hashPassword);
  assert.match(insecure.warnings.join(' '), /require https/);

  const shared = loadConfig({ ...base, A2W_SITES_BASE_DOMAIN: 'a2w.example.com' }, hashPassword);
  assert.match(shared.warnings.join(' '), /dedicated domain/);
});

test('numeric and boolean settings are parsed and range-checked', () => {
  const config = loadConfig(
    { ...base, A2W_PORT: '9000', A2W_KEEP_VERSIONS: '3', A2W_TRUST_PROXY: 'false', A2W_SITES_PATH_PREFIX: 'pages/' },
    hashPassword,
  );
  assert.equal(config.port, 9000);
  assert.equal(config.keepVersions, 3);
  assert.equal(config.trustProxy, false);
  assert.equal(config.sitesPathPrefix, '/pages');
  assert.throws(() => loadConfig({ ...base, A2W_PORT: '0' }, hashPassword), ConfigError);
  assert.throws(() => loadConfig({ ...base, A2W_KEEP_VERSIONS: 'many' }, hashPassword), ConfigError);
});

test('password hashing is salted and verification is exact', () => {
  const a = hashPassword('same-password');
  const b = hashPassword('same-password');
  assert.notEqual(a, b, 'each hash must use a fresh salt');
  assert.ok(verifyPassword('same-password', a));
  assert.ok(verifyPassword('same-password', b));
  assert.ok(!verifyPassword('other-password', a));
  assert.ok(!verifyPassword('same-password', 'not-a-hash'));
  assert.ok(!verifyPassword('same-password', 'scrypt$16384$8$1$bad$bad'));
});

test('TOTP codes verify within the drift window', () => {
  // RFC 6238 test vector secret "12345678901234567890" in base32.
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const now = 59_000;
  assert.ok(verifyTotp(secret, '287082', now));
  assert.ok(verifyTotp(secret, '287082', now + 30_000), 'one step of drift is allowed');
  assert.ok(!verifyTotp(secret, '287082', now + 120_000));
  assert.ok(!verifyTotp(secret, '000000', now));
  assert.ok(!verifyTotp(secret, 'abcdef', now));
  assert.ok(!verifyTotp('not base32 !!', '287082', now));
});

test('the throttle opens a window, blocks, then resets', () => {
  const throttle = new Throttle(2, 1000);
  assert.equal(throttle.check('k', 0), 0);
  throttle.fail('k', 0);
  throttle.fail('k', 100);
  assert.ok(throttle.check('k', 200) > 0);
  assert.equal(throttle.check('k', 1200), 0, 'window expires');

  throttle.fail('k', 1200);
  throttle.succeed('k');
  assert.equal(throttle.check('k', 1300), 0, 'success clears the counter');
});
