import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { ADMIN_PASSWORD, API_TOKEN, callTool, cookieValue, json, startHarness, type Harness } from './helpers.js';

let h: Harness;
let session: string;
let csrf: string;

before(async () => {
  h = await startHarness();
  await callTool(h.baseUrl, API_TOKEN, 'site_publish', { visibility: 'public', confirm_public: true, slug: 'admin-demo', html: '<p>demo</p>' });
});
after(async () => h.close());

test('the admin UI requires a session', async () => {
  const res = await fetch(`${h.baseUrl}/admin`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location') ?? '', /^\/admin\/login\?next=/);
});

test('a wrong admin password is rejected', async () => {
  const res = await login('nope');
  assert.equal(res.status, 401);
  assert.match(await res.text(), /Incorrect credentials/);
});

test('signing in lists the published sites', async () => {
  const res = await login(ADMIN_PASSWORD);
  assert.equal(res.status, 303);
  session = cookieValue(res.headers.getSetCookie(), 'a2w_admin')!;
  assert.ok(session);

  const page = await get('/admin');
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /admin-demo/);
  assert.match(body, /href="\/admin\/sites\/admin-demo"/, 'each row links to its own page');
  // The list is for scanning: mutations belong on the site page.
  assert.doesNotMatch(body, /action="\/admin\/sites\/[^"]+\/(access|domain|rollback|delete)"/);
  csrf = /name="csrf" value="([^"]+)"/.exec(body)![1]!;
});

test('the site page explains each control and carries every action', async () => {
  const page = await get('/admin/sites/admin-demo');
  assert.equal(page.status, 200);
  const body = await page.text();

  for (const action of ['access', 'domain', 'delete']) {
    assert.match(body, new RegExp(`action="/admin/sites/admin-demo/${action}"`), action);
  }
  // Every access option is offered with a plain-language description.
  for (const label of ['Anyone with the link', 'Password required', 'Not served']) {
    assert.ok(body.includes(label), `missing option "${label}"`);
  }
  assert.match(body, /Returns 404 to visitors/);
  // All three address forms are shown, and the reachable one is linked.
  assert.match(body, /Addresses/);
  assert.ok(body.includes(`${h.baseUrl}/s/admin-demo/`));
  assert.match(body, /Delete admin-demo/);
});

test('the site page 404s to the list with a message for an unknown slug', async () => {
  const res = await get('/admin/sites/no-such-site');
  assert.equal(res.status, 303);
  const location = decodeURIComponent(res.headers.get('location') ?? '');
  assert.match(location, /^\/admin\?err=/);
  assert.match(location, /No site called "no-such-site"/);
});

test('the site page requires a session', async () => {
  const res = await fetch(`${h.baseUrl}/admin/sites/admin-demo`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location') ?? '', /^\/admin\/login\?next=/);
});

test('mutations without a valid CSRF token are refused', async () => {
  const res = await post('/admin/sites/admin-demo/delete', { csrf: 'forged' });
  assert.equal(res.status, 403);
  assert.equal((await fetch(`${h.baseUrl}/s/admin-demo/`)).status, 200);
});

test('access can be changed from the admin UI', async () => {
  const res = await post('/admin/sites/admin-demo/access', {
    csrf,
    visibility: 'password',
    password: 'admin-set-password',
  });
  assert.equal(res.status, 303);
  // Actions return to the site they changed, carrying a message about it.
  const location = decodeURIComponent(res.headers.get('location') ?? '');
  assert.match(location, /^\/admin\/sites\/admin-demo\?ok=/);
  assert.match(location, /Password saved/);
  assert.equal((await fetch(`${h.baseUrl}/s/admin-demo/`)).status, 401);

  await post('/admin/sites/admin-demo/access', { csrf, visibility: 'public' });
  assert.equal((await fetch(`${h.baseUrl}/s/admin-demo/`)).status, 200);
});

test('a failed action reports the reason on the site page', async () => {
  const res = await post('/admin/sites/admin-demo/domain', { csrf, domain: 'not a hostname' });
  assert.equal(res.status, 303);
  const location = decodeURIComponent(res.headers.get('location') ?? '');
  assert.match(location, /^\/admin\/sites\/admin-demo\?err=/);
  assert.match(location, /valid hostname/);
});

test('rollback and delete work from the admin UI', async () => {
  await callTool(h.baseUrl, API_TOKEN, 'site_publish', { visibility: 'public', confirm_public: true, slug: 'admin-demo', html: '<p>demo v2</p>' });
  const versions = await h.db.all<{ id: string }>(
    'SELECT v.id FROM versions v JOIN sites s ON s.id = v.site_id WHERE s.slug = ? ORDER BY v.created_at ASC',
    'admin-demo',
  );
  assert.equal(versions.length, 2);

  const rolled = await post('/admin/sites/admin-demo/rollback', { csrf, version_id: versions[0]!.id });
  assert.equal(rolled.status, 303);
  assert.match(await (await fetch(`${h.baseUrl}/s/admin-demo/`)).text(), /^<p>demo<\/p>$/);

  const deleted = await post('/admin/sites/admin-demo/delete', { csrf });
  assert.equal(deleted.status, 303);
  assert.equal((await fetch(`${h.baseUrl}/s/admin-demo/`)).status, 404);
});

test('the connections page lists registered OAuth clients and can revoke them', async () => {
  const registered = await fetch(`${h.baseUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Revocable Client',
      token_endpoint_auth_method: 'none',
      redirect_uris: ['http://127.0.0.1:9999/cb'],
    }),
  });
  const client = await json(registered);

  const page = await get('/admin/connections');
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /Revocable Client/);
  const pageCsrf = /name="csrf" value="([^"]+)"/.exec(body)![1]!;

  const revoked = await post(`/admin/connections/${client.client_id}/revoke`, { csrf: pageCsrf });
  assert.equal(revoked.status, 303);
  const after = await (await get('/admin/connections')).text();
  assert.doesNotMatch(after, /Revocable Client/);
});

test('a client name cannot inject script into the connections page', async () => {
  // Registration is unauthenticated by design, so client_name is attacker input.
  // It reaches a confirm() dialog; an HTML escaper alone would not hold there,
  // because entities are decoded before the JS parser runs.
  const payload = `'+(window.__pwned=1)+'`;
  await fetch(`${h.baseUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: payload,
      token_endpoint_auth_method: 'none',
      redirect_uris: ['http://127.0.0.1:9997/cb'],
    }),
  });

  const body = await (await get('/admin/connections')).text();
  assert.ok(body.includes('&#39;+(window.__pwned=1)+&#39;'), 'the name should appear escaped');

  // Every inline handler must be a constant that reads its message from data-*.
  // \s so this matches attribute names, not the "on" inside e.g. content="…".
  const handlers = [...body.matchAll(/\son\w+="([^"]*)"/g)].map(m => m[1]!);
  assert.ok(handlers.length > 0, 'expected at least one inline handler to check');
  for (const handler of handlers) {
    assert.equal(handler, 'return confirm(this.dataset.confirm)', `unexpected handler: ${handler}`);
  }
});

test('signing out invalidates the session', async () => {
  const page = await get('/admin');
  const pageCsrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
  const out = await post('/admin/logout', { csrf: pageCsrf });
  assert.equal(out.status, 303);
  const afterLogout = await get('/admin');
  assert.equal(afterLogout.status, 302);
});

// ------------------------------------------------------------------ helpers

function login(password: string) {
  return fetch(`${h.baseUrl}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password, next: '/admin' }).toString(),
    redirect: 'manual',
  });
}

function get(path: string) {
  return fetch(`${h.baseUrl}${path}`, {
    headers: { cookie: `a2w_admin=${encodeURIComponent(session)}` },
    redirect: 'manual',
  });
}

function post(path: string, fields: Record<string, string>) {
  return fetch(`${h.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `a2w_admin=${encodeURIComponent(session)}`,
    },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
}
