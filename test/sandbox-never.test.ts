import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { API_TOKEN, callTool, rawRequest, startHarness, textOf, type Harness } from './helpers.js';

/**
 * Backlog #1. A path URL shares the admin origin. Unsandboxed, a published page
 * could fetch /admin with the owner's cookie, read the CSRF token from the HTML
 * and post a delete for every site. So A2W_SITE_SANDBOX=never must only ever
 * apply where a page has an origin of its own.
 */

let h: Harness;

before(async () => {
  h = await startHarness({ A2W_SITE_SANDBOX: 'never', A2W_SITES_BASE_DOMAIN: 'sites.example.test' });
  const res = await callTool(h.baseUrl, API_TOKEN, 'site_publish', {
    slug: 'page',
    html: '<p>hi</p>',
    visibility: 'public',
    confirm_public: true,
  });
  assert.notEqual(res.result.isError, true, textOf(res.result));
});
after(async () => h.close());

test('with sandbox=never a path URL is still sandboxed', async () => {
  const res = await rawRequest(h.port, '/s/page/');
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-security-policy']), /sandbox/);
});

test('with sandbox=never the site\'s own hostname is not sandboxed', async () => {
  const res = await rawRequest(h.port, '/', { host: 'page.sites.example.test' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-security-policy'], undefined);
});
