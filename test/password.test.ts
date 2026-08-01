import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { API_TOKEN, callTool, cookieValue, startHarness, structured, textOf, type Harness } from './helpers.js';

let h: Harness;

before(async () => {
  h = await startHarness();
  await callTool(h.baseUrl, API_TOKEN, 'site_publish', {
    slug: 'secret',
    title: 'Secret Plans',
    html: '<p>the secret content</p>',
    password: 'letmein-please',
  });
});
after(async () => h.close());

async function unlock(password: string) {
  return fetch(`${h.baseUrl}/s/secret/__a2w/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password, next: '/s/secret/' }).toString(),
    redirect: 'manual',
  });
}

test('publishing with a password switches the site to protected', async () => {
  const info = structured((await callTool(h.baseUrl, API_TOKEN, 'site_get', { slug: 'secret' })).result);
  assert.equal(info.visibility, 'password');
  assert.equal(info.password_protected, true);
});

test('an unauthenticated visitor gets the password form, not the content', async () => {
  const res = await fetch(`${h.baseUrl}/s/secret/`);
  assert.equal(res.status, 401);
  const body = await res.text();
  assert.match(body, /password protected/i);
  assert.doesNotMatch(body, /the secret content/);
  assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  // A native browser dialog would hide our form, so no WWW-Authenticate here.
  assert.equal(res.headers.get('www-authenticate'), null);
});

test('the wrong password is rejected', async () => {
  const res = await unlock('wrong-password');
  assert.equal(res.status, 401);
  assert.match(await res.text(), /Incorrect password/);
});

test('the right password sets a cookie that unlocks the site', async () => {
  const res = await unlock('letmein-please');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/s/secret/');
  const cookie = cookieValue(res.headers.getSetCookie(), `a2w_site_${await siteId()}`);
  assert.ok(cookie, 'expected a site cookie');

  const page = await fetch(`${h.baseUrl}/s/secret/`, {
    headers: { cookie: `a2w_site_${await siteId()}=${encodeURIComponent(cookie!)}` },
  });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /the secret content/);

  const setCookieHeader = res.headers.getSetCookie().join(';');
  assert.match(setCookieHeader, /HttpOnly/);
  assert.match(setCookieHeader, /Path=\/s\/secret/);
});

test('a forged cookie does not unlock the site', async () => {
  const page = await fetch(`${h.baseUrl}/s/secret/`, {
    headers: { cookie: `a2w_site_${await siteId()}=99999999999.deadbeefdeadbeef.forgedsignature` },
  });
  assert.equal(page.status, 401);
});

test('HTTP Basic auth works for scripted access', async () => {
  const ok = await fetch(`${h.baseUrl}/s/secret/`, {
    headers: { authorization: `Basic ${Buffer.from(':letmein-please').toString('base64')}` },
  });
  assert.equal(ok.status, 200);

  const bad = await fetch(`${h.baseUrl}/s/secret/`, {
    headers: { authorization: `Basic ${Buffer.from(':nope').toString('base64')}` },
  });
  assert.equal(bad.status, 401);
});

test('rotating the password invalidates cookies issued for the old one', async () => {
  const unlocked = await unlock('letmein-please');
  const cookie = cookieValue(unlocked.headers.getSetCookie(), `a2w_site_${await siteId()}`)!;

  await callTool(h.baseUrl, API_TOKEN, 'site_set_access', {
    slug: 'secret',
    visibility: 'password',
    password: 'a-brand-new-password',
  });

  const stale = await fetch(`${h.baseUrl}/s/secret/`, {
    headers: { cookie: `a2w_site_${await siteId()}=${encodeURIComponent(cookie)}` },
  });
  assert.equal(stale.status, 401);
});

test('repeated failures are throttled', async () => {
  let throttled = false;
  for (let i = 0; i < 14; i++) {
    const res = await unlock(`nope-${i}`);
    if (res.status === 429) {
      throttled = true;
      assert.ok(Number(res.headers.get('retry-after')) > 0);
      break;
    }
  }
  assert.ok(throttled, 'expected a 429 after repeated failures');
});

test('making a site public clears the password; disabling hides it', async () => {
  await callTool(h.baseUrl, API_TOKEN, 'site_set_access', {
    slug: 'secret',
    visibility: 'public',
    confirm_public: true,
  });
  const open = await fetch(`${h.baseUrl}/s/secret/`);
  assert.equal(open.status, 200);

  await callTool(h.baseUrl, API_TOKEN, 'site_set_access', { slug: 'secret', visibility: 'disabled' });
  const hidden = await fetch(`${h.baseUrl}/s/secret/`);
  assert.equal(hidden.status, 404);
});

test('locking a site with no password mints one rather than refusing', async () => {
  await callTool(h.baseUrl, API_TOKEN, 'site_publish', {
    visibility: 'public',
    confirm_public: true,
    slug: 'open-site',
    html: '<p>open</p>',
  });
  // This used to be an error. Refusing left the caller stuck, and the obvious
  // workaround — writing a null hash — produced a site nobody could open.
  const res = await callTool(h.baseUrl, API_TOKEN, 'site_set_access', {
    slug: 'open-site',
    visibility: 'password',
  });
  assert.notEqual(res.result.isError, true, textOf(res.result));
  const minted = structured(res.result).generated_password as string;
  assert.ok(minted, 'expected a minted password');
  const opened = await fetch(`${h.baseUrl}/s/open-site/`, {
    headers: { authorization: 'Basic ' + Buffer.from(`:${minted}`).toString('base64') },
  });
  assert.equal(opened.status, 200);

  const tooShort = await callTool(h.baseUrl, API_TOKEN, 'site_set_access', {
    slug: 'open-site',
    visibility: 'password',
    password: 'abc',
  });
  assert.equal(tooShort.result.isError, true);
});

async function siteId(): Promise<string> {
  return (await h.db.first<{ id: string }>('SELECT id FROM sites WHERE slug = ?', 'secret'))!.id;
}

test('Basic auth is throttled, so it cannot brute force past the form limiter', async () => {
  // An earlier test disables this site, so re-arm it rather than depending on
  // whatever the previous test left behind.
  await callTool(h.baseUrl, API_TOKEN, 'site_set_access', {
    slug: 'secret',
    visibility: 'password',
    password: 'a-brand-new-password',
  });

  // Basic auth issues no cookie, so each attempt pays the full key derivation.
  // Left unthrottled it would be both a brute-force channel and a way to burn
  // the Workers CPU allowance.
  const attempt = (password: string) =>
    fetch(`${h.baseUrl}/s/secret/`, {
      headers: { authorization: `Basic ${Buffer.from(`:${password}`).toString('base64')}` },
    });

  let throttled = false;
  for (let i = 0; i < 14; i++) {
    const res = await attempt(`wrong-${i}`);
    if (res.status === 429) {
      throttled = true;
      assert.ok(Number(res.headers.get('retry-after')) > 0, 'expected Retry-After');
      break;
    }
    assert.equal(res.status, 401);
  }
  assert.ok(throttled, 'expected Basic auth attempts to be throttled');

  // While throttled, even the correct password is refused rather than hashed.
  assert.equal((await attempt('a-brand-new-password')).status, 429);
});
