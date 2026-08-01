import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import {
  ADMIN_PASSWORD, API_TOKEN, callTool, rawRequest, startHarness, structured, type Harness,
} from './helpers.js';

let h: Harness;
// A fresh deploy: nobody could have known the URL, so the variable is unset.
before(async () => { h = await startHarness({ A2W_PUBLIC_URL: undefined }); });
after(async () => h.close());

const stored = async () =>
  (await h.db.first<{ value: string }>("SELECT value FROM schema_meta WHERE key = 'public_url'"))
    ?.value;

test('an anonymous request is served but teaches the deployment nothing', async () => {
  assert.equal((await fetch(`${h.baseUrl}/healthz`)).status, 200);
  assert.equal(await stored(), undefined, 'nothing should be recorded yet');
});

test('an anonymous request cannot poison the origin with a chosen Host', async () => {
  // Trust-on-first-use: whoever lands the first request would otherwise set the
  // OAuth issuer, and — because every real hostname would then look like an
  // unknown site — 404 the whole instance.
  for (const host of ['evil.example', 'attacker.workers.dev']) {
    await rawRequest(h.port, '/healthz', { host });
    await rawRequest(h.port, '/admin/login', { host });
    await rawRequest(h.port, '/.well-known/oauth-authorization-server', { host });
  }
  assert.equal(await stored(), undefined, 'an unauthenticated Host must never be recorded');

  // And the instance still answers on its real hostname.
  assert.equal((await fetch(`${h.baseUrl}/healthz`)).status, 200);
});

test('a failed admin login does not record the origin either', async () => {
  const res = await fetch(`${h.baseUrl}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'wrong-password' }).toString(),
    redirect: 'manual',
  });
  assert.equal(res.status, 401);
  assert.equal(await stored(), undefined);
});

test('an authenticated MCP call records it', async () => {
  const { result } = await callTool(h.baseUrl, API_TOKEN, 'site_publish', { visibility: 'public', confirm_public: true,
    slug: 'learned', html: '<h1>learned</h1>',
  });
  assert.equal(structured(result).slug, 'learned');
  await new Promise(r => setTimeout(r, 400)); // waitUntil
  assert.equal(await stored(), h.baseUrl);
});

test('once recorded it is the OAuth issuer, and a later Host cannot move it', async () => {
  const meta = (await (await fetch(`${h.baseUrl}/.well-known/oauth-authorization-server`)).json()) as any;
  assert.equal(meta.issuer, `${h.baseUrl}/`);

  await rawRequest(h.port, '/healthz', { host: 'evil.example' });
  await callTool(h.baseUrl, API_TOKEN, 'site_list', {});
  await new Promise(r => setTimeout(r, 400));
  assert.equal(await stored(), h.baseUrl, 'first writer wins');
});

test('an admin sign-in also records it', async () => {
  const fresh = await startHarness({ A2W_PUBLIC_URL: undefined });
  try {
    const res = await fetch(`${fresh.baseUrl}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: ADMIN_PASSWORD, next: '/admin' }).toString(),
      redirect: 'manual',
    });
    assert.equal(res.status, 303);
    await new Promise(r => setTimeout(r, 400));
    const v = await fresh.db.first<{ value: string }>(
      "SELECT value FROM schema_meta WHERE key = 'public_url'",
    );
    assert.equal(v?.value, fresh.baseUrl);
  } finally {
    await fresh.close();
  }
});

test('an explicit A2W_PUBLIC_URL always wins and is never overwritten', async () => {
  const pinned = await startHarness({ A2W_PUBLIC_URL: 'https://pinned.example.com' });
  try {
    const meta = (await (
      await fetch(`${pinned.baseUrl}/.well-known/oauth-authorization-server`)
    ).json()) as any;
    assert.equal(meta.issuer, 'https://pinned.example.com/');
  } finally {
    await pinned.close();
  }
});
