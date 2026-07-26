import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { ConfigError, loadConfig } from '../src/core/config.js';
import { WebCryptoProvider } from '../src/core/crypto.js';

const crypto = new WebCryptoProvider();
const load = (env: Record<string, string | undefined>) => loadConfig(env, crypto);

let base: Record<string, string>;
const baseEnv = async () => {
  base ??= {
    A2W_PUBLIC_URL: 'https://a2w.example.com',
    A2W_SECRET: 'x'.repeat(40),
    A2W_ADMIN_PASSWORD_HASH: await crypto.hashPassword('a-good-admin-password'),
  };
  return base;
};

test('valid configuration is normalised', async () => {
  const config = await load({ ...(await baseEnv()), A2W_PUBLIC_URL: 'https://a2w.example.com/' });
  assert.equal(config.publicUrl, 'https://a2w.example.com');
  assert.equal(config.mcpUrl, 'https://a2w.example.com/mcp');
  assert.equal(config.sitesPathPrefix, '/s');
  assert.equal(config.keepVersions, 10);
  assert.deepEqual(config.warnings, []);
});

test('missing or weak required values fail fast with a readable message', async () => {
  const b = await baseEnv();
  await assert.rejects(() => load({}), ConfigError);
  await assert.rejects(() => load({ ...b, A2W_SECRET: 'too-short' }), /at least 32 characters/);
  await assert.rejects(() => load({ ...b, A2W_PUBLIC_URL: 'a2w.example.com' }), /must be an origin/);
  await assert.rejects(() => load({ ...b, A2W_PUBLIC_URL: 'https://a2w.example.com/base' }), /no path/);
  await assert.rejects(() => load({ ...b, A2W_API_TOKEN: 'short-token' }), /A2W_API_TOKEN/);

  const { A2W_ADMIN_PASSWORD_HASH: _omit, ...noHash } = b;
  await assert.rejects(() => load(noHash), /A2W_ADMIN_PASSWORD_HASH/);
  await assert.rejects(
    () => load({ ...noHash, A2W_ADMIN_PASSWORD: 'short' }),
    /at least 12 characters/,
  );
});

test('a hash this build cannot verify stops startup, not the login form', async () => {
  const b = await baseEnv();
  // scrypt was the self-hosted build's format. Cloudflare has no scrypt, so a
  // hash carried over would reject every correct password at the login form
  // unless startup refuses it and says why.
  // Synthetic: a scrypt hash of a throwaway string, never any real credential.
  const scrypt = 'scrypt.16384.8.1.lb-a6OC7VST81WqHb_sQXA.cxwLSBEzdyJoc3ft52u2XQ8tgDd9luMfxdN_7CfX61g';
  await assert.rejects(() => load({ ...b, A2W_ADMIN_PASSWORD_HASH: scrypt }), /can verify/);
  await assert.rejects(() => load({ ...b, A2W_ADMIN_PASSWORD_HASH: scrypt }), /Cloudflare has no/);

  for (const bad of [
    'pbkdf2',
    'pbkdf2.600000.onlythree',
    'bcrypt.600000.c2FsdA.a2V5',
    'pbkdf2.10.c2FsdA.a2V5', // iteration count below the floor
    'pbkdf2-600000-c2FsdA-a2V5', // shell-mangled: separators eaten
  ]) {
    await assert.rejects(() => load({ ...b, A2W_ADMIN_PASSWORD_HASH: bad }), ConfigError, bad);
  }
});

test('hashes survive an unquoted shell round trip', async () => {
  const hash = await crypto.hashPassword('a-good-admin-password');
  assert.match(hash, /^pbkdf2\.600000\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  // A "$" here would be expanded by the shell in an unquoted .env line, which is
  // exactly how the previous format silently corrupted itself.
  assert.ok(!hash.includes('$'));
  assert.equal(execFileSync('/bin/sh', ['-c', `printf %s "${hash}"`], { encoding: 'utf8' }), hash);
  assert.ok(await crypto.verifyPassword('a-good-admin-password', hash));
});

test('setting both the hash and a plaintext password warns that the hash wins', async () => {
  const config = await load({ ...(await baseEnv()), A2W_ADMIN_PASSWORD: 'some-other-password' });
  assert.match(config.warnings.join(' '), /the hash wins/);
  assert.ok(await crypto.verifyPassword('a-good-admin-password', config.adminPasswordHash));
  assert.ok(!(await crypto.verifyPassword('some-other-password', config.adminPasswordHash)));
});

test('a plaintext admin password is accepted but warned about', async () => {
  const { A2W_ADMIN_PASSWORD_HASH: _omit, ...noHash } = await baseEnv();
  const config = await load({ ...noHash, A2W_ADMIN_PASSWORD: 'a-long-enough-password' });
  assert.ok(await crypto.verifyPassword('a-long-enough-password', config.adminPasswordHash));
  assert.match(config.warnings.join(' '), /plaintext/);
});

test('http public URLs and shared site domains raise warnings', async () => {
  const b = await baseEnv();
  const insecure = await load({ ...b, A2W_PUBLIC_URL: 'http://a2w.example.com' });
  assert.match(insecure.warnings.join(' '), /require https/);

  const shared = await load({ ...b, A2W_SITES_BASE_DOMAIN: 'a2w.example.com' });
  assert.match(shared.warnings.join(' '), /dedicated domain/);
});

test('numeric settings are parsed and range-checked', async () => {
  const b = await baseEnv();
  const config = await load({
    ...b,
    A2W_KEEP_VERSIONS: '3',
    A2W_SITES_PATH_PREFIX: 'pages/',
    A2W_MAX_SITE_BYTES: '26214400',
  });
  assert.equal(config.keepVersions, 3);
  assert.equal(config.sitesPathPrefix, '/pages');
  assert.equal(config.maxSiteBytes, 26_214_400);
  await assert.rejects(() => load({ ...b, A2W_KEEP_VERSIONS: 'many' }), ConfigError);
  await assert.rejects(() => load({ ...b, A2W_MAX_FILES: '0' }), ConfigError);
});
