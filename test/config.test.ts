import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { ConfigError, loadConfig } from '../src/config.js';
import { hashPassword, isValidPasswordHash, verifyPassword } from '../src/auth/passwords.js';
import { verifyTotp } from '../src/auth/totp.js';
import { Throttle } from '../src/auth/throttle.js';

const base = {
  A2W_PUBLIC_URL: 'https://a2w.example.com',
  A2W_SECRET: 'x'.repeat(40),
  A2W_ADMIN_PASSWORD_HASH: hashPassword('a-good-admin-password'),
} as NodeJS.ProcessEnv;

test('valid configuration is normalised', () => {
  const config = loadConfig({ ...base, A2W_PUBLIC_URL: 'https://a2w.example.com/' });
  assert.equal(config.publicUrl, 'https://a2w.example.com');
  assert.equal(config.mcpUrl, 'https://a2w.example.com/mcp');
  assert.equal(config.sitesPathPrefix, '/s');
  assert.equal(config.dataDir, '/data');
  assert.equal(config.port, 8080);
  assert.equal(config.keepVersions, 10);
  assert.deepEqual(config.warnings, []);
});

test('missing or weak required values fail fast with a readable message', () => {
  assert.throws(() => loadConfig({} as NodeJS.ProcessEnv), ConfigError);
  assert.throws(
    () => loadConfig({ ...base, A2W_SECRET: 'too-short' }),
    /at least 32 characters/,
  );
  assert.throws(
    () => loadConfig({ ...base, A2W_PUBLIC_URL: 'a2w.example.com' }),
    /must be an origin/,
  );
  assert.throws(
    () => loadConfig({ ...base, A2W_PUBLIC_URL: 'https://a2w.example.com/base' }),
    /no path/,
  );
  const { A2W_ADMIN_PASSWORD_HASH: _omit, ...noHash } = base as Record<string, string>;
  assert.throws(() => loadConfig(noHash as NodeJS.ProcessEnv), /A2W_ADMIN_PASSWORD_HASH/);
  assert.throws(
    () => loadConfig({ ...noHash, A2W_ADMIN_PASSWORD: 'short' } as NodeJS.ProcessEnv),
    /at least 12 characters/,
  );
  assert.throws(() => loadConfig({ ...base, A2W_API_TOKEN: 'short-token' }), /A2W_API_TOKEN/);
});

test('a corrupted password hash fails at startup, not at the login form', () => {
  // What `set -a && . ./.env` produces when the $-separated hash is unquoted:
  // the shell expands $16384, $8, $1 and the base64 chunks into nothing.
  const shellMangled = 'scrypt-gXD3gcB4B0BZ3o392w-w4SYkYo';
  assert.throws(
    () => loadConfig({ ...base, A2W_ADMIN_PASSWORD_HASH: shellMangled }),
    /not a valid scrypt hash/,
  );
  assert.throws(
    () => loadConfig({ ...base, A2W_ADMIN_PASSWORD_HASH: shellMangled }),
    /quote it in \.env/,
  );

  for (const bad of ['scrypt', 'scrypt.16384.8.1.onlyfive', 'bcrypt.16384.8.1.c2FsdA.a2V5', 'scrypt.0.8.1.c2FsdA.a2V5']) {
    assert.throws(() => loadConfig({ ...base, A2W_ADMIN_PASSWORD_HASH: bad }), ConfigError, bad);
  }
});

test('hashes are free of characters a shell would expand', () => {
  const hash = hashPassword('a-good-admin-password');
  assert.ok(!hash.includes('$'), 'a $ in the hash breaks unquoted .env lines');
  assert.match(hash, /^scrypt\.16384\.8\.1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  // Surviving a round trip through the shell is the whole point.
  assert.equal(execFileSync('/bin/sh', ['-c', `printf %s "${hash}"`], { encoding: 'utf8' }), hash);
  assert.ok(verifyPassword('a-good-admin-password', hash));
});

test('hashes in the older $-separated format still verify', () => {
  const legacy = hashPassword('legacy-password').replaceAll('.', '$');
  assert.ok(verifyPassword('legacy-password', legacy));
  assert.ok(!verifyPassword('wrong-password', legacy));
  assert.ok(isValidPasswordHash(legacy));
  assert.doesNotThrow(() => loadConfig({ ...base, A2W_ADMIN_PASSWORD_HASH: legacy }));
});

test('setting both the hash and a plaintext password warns that the hash wins', () => {
  const config = loadConfig({ ...base, A2W_ADMIN_PASSWORD: 'some-other-password' });
  assert.match(config.warnings.join(' '), /the hash wins/);
  assert.ok(verifyPassword('a-good-admin-password', config.adminPasswordHash));
  assert.ok(!verifyPassword('some-other-password', config.adminPasswordHash));
});

test('a plaintext admin password is accepted but warned about', () => {
  const { A2W_ADMIN_PASSWORD_HASH: _omit, ...noHash } = base as Record<string, string>;
  const config = loadConfig(
    { ...noHash, A2W_ADMIN_PASSWORD: 'a-long-enough-password' } as NodeJS.ProcessEnv,
  );
  assert.ok(verifyPassword('a-long-enough-password', config.adminPasswordHash));
  assert.match(config.warnings.join(' '), /plaintext/);
});

test('http public URLs and shared site domains raise warnings', () => {
  const insecure = loadConfig({ ...base, A2W_PUBLIC_URL: 'http://a2w.example.com' });
  assert.match(insecure.warnings.join(' '), /require https/);

  const shared = loadConfig({ ...base, A2W_SITES_BASE_DOMAIN: 'a2w.example.com' });
  assert.match(shared.warnings.join(' '), /dedicated domain/);
});

test('numeric and boolean settings are parsed and range-checked', () => {
  const config = loadConfig(
    { ...base, A2W_PORT: '9000', A2W_KEEP_VERSIONS: '3', A2W_TRUST_PROXY: 'false', A2W_SITES_PATH_PREFIX: 'pages/' },
  );
  assert.equal(config.port, 9000);
  assert.equal(config.keepVersions, 3);
  assert.equal(config.trustProxy, false);
  assert.equal(config.sitesPathPrefix, '/pages');
  assert.throws(() => loadConfig({ ...base, A2W_PORT: '0' }), ConfigError);
  assert.throws(() => loadConfig({ ...base, A2W_KEEP_VERSIONS: 'many' }), ConfigError);
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
