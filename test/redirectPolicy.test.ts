import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/auth/passwords.js';
import { isAllowedRedirectUri } from '../src/auth/redirectPolicy.js';

/**
 * Exercised against a production-shaped config: the integration tests run on
 * http://127.0.0.1, where the loopback rule allows everything by design.
 */
const config = loadConfig(
  {
    A2W_PUBLIC_URL: 'https://a2w.example.com',
    A2W_SECRET: 'x'.repeat(40),
    A2W_ADMIN_PASSWORD_HASH: hashPassword('a-good-admin-password'),
    A2W_EXTRA_REDIRECT_URIS: 'https://tools.example.org/oauth/callback',
  } as NodeJS.ProcessEnv,
  hashPassword,
);

test('Claude hosted callbacks and loopback URIs are allowed', () => {
  for (const uri of [
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
    'https://claude.ai/some/other/callback/path',
    'http://127.0.0.1:1455/callback',
    'http://localhost:63311/oauth/callback',
    'http://[::1]:8000/cb',
    'https://tools.example.org/oauth/callback',
  ]) {
    assert.ok(isAllowedRedirectUri(config, uri), `${uri} should be allowed`);
  }
});

test('everything else is refused', () => {
  for (const uri of [
    'https://evil.example.com/callback',
    'https://claude.ai.evil.example.com/cb',
    'https://evil.example.com/claude.ai/cb',
    'http://claude.ai/cb',
    'https://user:pass@claude.ai/cb',
    'https://claude.ai/cb#fragment',
    'http://8.8.8.8:80/cb',
    'http://127.0.0.1.evil.example.com/cb',
    'javascript:alert(1)',
    'not-a-url',
    '',
    // A page hosted by this very server must not be able to receive codes.
    'https://a2w.example.com/s/some-site/',
    'https://a2w.example.com/callback',
  ]) {
    assert.ok(!isAllowedRedirectUri(config, uri), `${uri} should be refused`);
  }
});
