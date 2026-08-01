import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { API_TOKEN, callTool, rawRequest, startHarness, type Harness } from './helpers.js';

let h: Harness;
before(async () => {
  h = await startHarness();
  await callTool(h.baseUrl, API_TOKEN, 'site_publish', { visibility: 'public', confirm_public: true, slug: 'pub', html: '<h1>public content</h1>' });
  await callTool(h.baseUrl, API_TOKEN, 'site_publish', {
    slug: 'secret', html: '<h1>SECRET CONTENT</h1>', password: 'open-sesame',
  });
});
after(async () => h.close());

/**
 * The URL constructor resolves ".." per RFC 3986, so a traversal can land on a
 * different site. That is fine — what must never happen is reaching content past
 * an access gate, or escaping the site's own version prefix.
 */
test('a traversal cannot reach a password-protected site', async () => {
  for (const path of [
    '/s/pub/../secret/',
    '/s/pub/../secret/index.html',
    '/s/pub/%2e%2e/secret/',
    '/s/pub/../../s/secret/',
    '/s/pub/....//secret/',
    '/s/pub/..%2fsecret%2f',
  ]) {
    const res = await rawRequest(h.port, path);
    assert.doesNotMatch(res.body, /SECRET CONTENT/, `${path} leaked protected content`);
  }
});

test('a traversal cannot escape the site version prefix', async () => {
  for (const path of [
    '/s/pub/../../../etc/passwd',
    '/s/pub/..%2f..%2f..%2fsites',
    '/s/pub/%2e%2e%2f%2e%2e%2fagent2web.db',
  ]) {
    const res = await rawRequest(h.port, path);
    assert.notEqual(res.status, 200, `${path} served something`);
  }
});
