import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { startHarness, type Harness } from './helpers.js';

let h: Harness;
// A2W_PUBLIC_URL deliberately unset: this is a fresh deploy where nobody could
// have known the URL yet.
before(async () => { h = await startHarness({ A2W_PUBLIC_URL: undefined }); });
after(async () => h.close());

test('a Worker with no A2W_PUBLIC_URL learns it from the first request', async () => {
  const res = await fetch(`${h.baseUrl}/healthz`);
  assert.equal(res.status, 200, 'it should boot rather than refuse to start');

  const stored = await h.db.first<{ value: string }>(
    "SELECT value FROM schema_meta WHERE key = 'public_url'",
  );
  assert.equal(stored?.value, h.baseUrl, 'the origin should be remembered');
});

test('the learned URL is used as the OAuth issuer and token audience', async () => {
  const meta = await (await fetch(`${h.baseUrl}/.well-known/oauth-authorization-server`)).json() as any;
  assert.equal(meta.issuer, `${h.baseUrl}/`);
  assert.equal(meta.token_endpoint, `${h.baseUrl}/token`);

  const prm = await (await fetch(`${h.baseUrl}/.well-known/oauth-protected-resource/mcp`)).json() as any;
  assert.equal(prm.resource, `${h.baseUrl}/mcp`);
});

test('it stays put once learned, even when a later request uses another host', async () => {
  const { rawRequest } = await import('./helpers.js');
  await rawRequest(h.port, '/healthz', { host: 'some-other-host.example' });
  const stored = await h.db.first<{ value: string }>(
    "SELECT value FROM schema_meta WHERE key = 'public_url'",
  );
  assert.equal(stored?.value, h.baseUrl, 'a stray Host header must not move the issuer');
});

test('publishing works end to end without the variable ever being set', async () => {
  const { callTool, API_TOKEN, structured } = await import('./helpers.js');
  const { result } = await callTool(h.baseUrl, API_TOKEN, 'site_publish', {
    slug: 'no-config', html: '<h1>deployed blind</h1>',
  });
  assert.equal(structured(result).urls.path, `${h.baseUrl}/s/no-config/`);
  const page = await fetch(`${h.baseUrl}/s/no-config/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /deployed blind/);
});
