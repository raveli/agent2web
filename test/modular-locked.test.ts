import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { API_TOKEN, callTool, rawRequest, startHarness, structured, textOf, type Harness } from './helpers.js';

/**
 * A locked site with its own hostname can be split into separate files.
 *
 * The opaque-origin problem in subresources.test.ts belongs to the sandbox, and
 * the sandbox belongs to path-based URLs. On <slug>.<base domain> the page has a
 * real origin, so its same-origin CSS and JS carry the unlock cookie. These
 * tests pin that, and that the path URL sends visitors to the hostname.
 */

const HOST = 'modular.sites.example.test';
const PASSWORD = 'letmein-please';

let h: Harness;

before(async () => {
  h = await startHarness({ A2W_SITES_BASE_DOMAIN: 'sites.example.test' });
});
after(async () => h.close());

const FILES = [
  { path: 'index.html', content: '<link rel="stylesheet" href="app.css"><script src="js/app.js"></script><p>hi</p>' },
  { path: 'app.css', content: 'body{color:red}' },
  { path: 'js/app.js', content: 'console.log(1)' },
];

async function unlock(): Promise<string> {
  const res = await rawRequest(h.port, '/__a2w/login', {
    method: 'POST',
    host: HOST,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `password=${PASSWORD}&next=/`,
  });
  assert.equal(res.status, 303, res.body);
  const setCookie = [res.headers['set-cookie'] ?? []].flat()[0]!;
  assert.match(setCookie, /Path=\//);
  return setCookie.split(';')[0]!;
}

test('publishing a locked multi-file site with a hostname does not warn', async () => {
  const res = await callTool(h.baseUrl, API_TOKEN, 'site_publish', { slug: 'modular', files: FILES, password: PASSWORD });
  assert.notEqual(res.result.isError, true, textOf(res.result));
  assert.equal(structured(res.result).warnings, undefined, textOf(res.result));
});

test('on its hostname a locked page is not sandboxed and its CSS and JS load once unlocked', async () => {
  const cookie = await unlock();
  const page = await rawRequest(h.port, '/', { host: HOST, headers: { cookie } });
  assert.equal(page.status, 200);
  assert.equal(page.headers['content-security-policy'], undefined);

  for (const [path, dest, body] of [
    ['/app.css', 'style', 'body{color:red}'],
    ['/js/app.js', 'script', 'console.log(1)'],
  ]) {
    const res = await rawRequest(h.port, path!, { host: HOST, headers: { cookie, 'sec-fetch-dest': dest! } });
    assert.equal(res.status, 200, path);
    assert.equal(res.body, body);
  }
});

test('without the cookie the subresources stay locked', async () => {
  const res = await rawRequest(h.port, '/app.css', { host: HOST, headers: { 'sec-fetch-dest': 'style' } });
  assert.equal(res.status, 401);
});

test('the path URL of a locked site redirects to its hostname, keeping path and query', async () => {
  const res = await rawRequest(h.port, '/s/modular/js/app.js?v=2');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `http://${HOST}:${h.port}/js/app.js?v=2`);
});

test('public sites keep answering on the path URL', async () => {
  await callTool(h.baseUrl, API_TOKEN, 'site_publish', {
    slug: 'open', files: FILES, visibility: 'public', confirm_public: true,
  });
  const res = await rawRequest(h.port, '/s/open/app.css');
  assert.equal(res.status, 200);
});
