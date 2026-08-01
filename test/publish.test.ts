import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import {
  API_TOKEN,
  callTool,
  mcpRequest,
  rawRequest,
  startHarness,
  structured,
  textOf,
  type Harness,
} from './helpers.js';

let h: Harness;

before(async () => {
  h = await startHarness({ A2W_SITES_BASE_DOMAIN: 'sites.example.test', A2W_KEEP_VERSIONS: '3' });
});
after(async () => h.close());

test('tools/list advertises the site tools with annotations', async () => {
  const res = await mcpRequest(h.baseUrl, API_TOKEN, 'tools/list');
  const names = res.result.tools.map((t: any) => t.name);
  for (const expected of [
    'site_publish',
    'site_update_files',
    'site_list',
    'site_get',
    'site_read_file',
    'site_set_access',
    'site_rename',
    'site_set_domain',
    'site_list_versions',
    'site_rollback',
    'site_delete',
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  const del = res.result.tools.find((t: any) => t.name === 'site_delete');
  assert.equal(del.annotations.destructiveHint, true);
  const list = res.result.tools.find((t: any) => t.name === 'site_list');
  assert.equal(list.annotations.readOnlyHint, true);
});

test('publishing a single page serves it over the path URL', async () => {
  const { result } = await callTool(h.baseUrl, API_TOKEN, 'site_publish', { visibility: 'public', confirm_public: true,
    slug: 'hello',
    title: 'Hello',
    html: '<!doctype html><title>Hello</title><h1>Hi there</h1>',
  });
  const data = structured(result);
  assert.equal(data.slug, 'hello');
  assert.equal(data.created, true);
  assert.equal(data.urls.path, `${h.baseUrl}/s/hello/`);
  // Host-based URLs must carry the app's port, or they do not resolve when the
  // app runs on anything other than 80/443 (i.e. every local run).
  assert.equal(data.urls.subdomain, `http://hello.sites.example.test:${h.port}/`);

  const page = await fetch(`${h.baseUrl}/s/hello/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await page.text(), /Hi there/);

  // Path-based hosting shares the app origin, so the sandbox CSP must be set.
  const csp = page.headers.get('content-security-policy') ?? '';
  assert.match(csp, /sandbox/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
});

test('a bare site path redirects so relative links resolve', async () => {
  const res = await fetch(`${h.baseUrl}/s/hello`, { redirect: 'manual' });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/s/hello/');
});

test('subdomain hosting resolves by Host header and is not sandboxed', async () => {
  const res = await rawRequest(h.port, '/', { host: 'hello.sites.example.test' });
  assert.equal(res.status, 200);
  assert.match(res.body, /Hi there/);
  assert.equal(res.headers['content-security-policy'], undefined);
});

test('the app endpoints are unreachable on a site hostname', async () => {
  for (const path of ['/admin', '/mcp', '/healthz', '/.well-known/oauth-authorization-server']) {
    const res = await rawRequest(h.port, path, { host: 'hello.sites.example.test' });
    assert.equal(res.status, 404, `${path} should not be reachable from a site host`);
  }
});

test('unknown subdomain and unknown slug both 404', async () => {
  const bySubdomain = await rawRequest(h.port, '/', { host: 'nope.sites.example.test' });
  assert.equal(bySubdomain.status, 404);
  assert.match(bySubdomain.body, /no site called/);
  const byPath = await fetch(`${h.baseUrl}/s/nope/`);
  assert.equal(byPath.status, 404);
});

test('multi-file publish serves assets and honours the custom 404 page', async () => {
  const { result } = await callTool(h.baseUrl, API_TOKEN, 'site_publish', { visibility: 'public', confirm_public: true,
    slug: 'multi',
    files: [
      { path: 'index.html', content: '<link rel=stylesheet href="assets/app.css"><p>index</p>' },
      { path: 'assets/app.css', content: 'body{color:red}' },
      { path: '404.html', content: '<p>custom missing page</p>' },
      { path: 'img/dot.png', content: 'iVBORw0KGgo=', encoding: 'base64' },
    ],
  });
  assert.equal(structured(result).slug, 'multi');

  const css = await fetch(`${h.baseUrl}/s/multi/assets/app.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') ?? '', /text\/css/);
  assert.match(css.headers.get('cache-control') ?? '', /max-age=300/);

  const png = await fetch(`${h.baseUrl}/s/multi/img/dot.png`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');

  const missing = await fetch(`${h.baseUrl}/s/multi/nothing-here`);
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /custom missing page/);
  // The custom 404 is user content too, so it must carry the same protections.
  assert.match(missing.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.equal(missing.headers.get('x-content-type-options'), 'nosniff');
});

test('traversal attempts cannot escape a site', async () => {
  // Anything the URL parser leaves intact reaches the app as a literal segment
  // and must be refused rather than resolved.
  for (const path of [
    '/s/multi/%2e%2e%2fhello/index.html',
    '/s/multi/..%5cindex.html',
    '/s/multi/....//hello/index.html',
    `/s/multi/${'..%2f'.repeat(6)}etc/passwd`,
  ]) {
    const res = await rawRequest(h.port, path);
    assert.notEqual(res.status, 200, `${path} unexpectedly served content`);
    assert.doesNotMatch(res.body, /Hi there/, `${path} leaked another site's content`);
  }

  // Dot segments are different. The WHATWG URL parser resolves them before the
  // app sees the path — and treats %2e as a dot, so the encoded spelling is not a
  // way around it either. /s/multi/../hello/ is therefore just a request for
  // /s/hello/: content the client could have asked for directly. What must hold
  // is that it cannot reach past an access gate or leave the version prefix,
  // which traversal.test.ts asserts against a password-protected site.
  for (const path of ['/s/multi/../hello/index.html', '/s/multi/%2e%2e/hello/index.html']) {
    const res = await rawRequest(h.port, path);
    assert.equal(res.status, 200, path);
    assert.match(res.body, /Hi there/, `expected ${path} to resolve to /s/hello/`);
  }
});

test('publish requires index.html and enforces limits', async () => {
  const noIndex = await callTool(h.baseUrl, API_TOKEN, 'site_publish', { visibility: 'public', confirm_public: true,
    slug: 'no-index',
    files: [{ path: 'about.html', content: 'hi' }],
  });
  assert.equal(noIndex.result.isError, true);
  assert.match(textOf(noIndex.result), /index\.html/);

  const tooBig = await callTool(h.baseUrl, API_TOKEN, 'site_publish', { visibility: 'public', confirm_public: true,
    slug: 'too-big',
    html: 'x'.repeat(6 * 1024 * 1024),
  });
  assert.equal(tooBig.result.isError, true);
  assert.match(textOf(tooBig.result), /per-file limit/);

  const bothInputs = await callTool(h.baseUrl, API_TOKEN, 'site_publish', { visibility: 'public', confirm_public: true,
    slug: 'both',
    html: 'x',
    files: [{ path: 'index.html', content: 'y' }],
  });
  assert.equal(bothInputs.result.isError, true);

  const badPath = await callTool(h.baseUrl, API_TOKEN, 'site_publish', { visibility: 'public', confirm_public: true,
    slug: 'bad-path',
    files: [
      { path: 'index.html', content: 'ok' },
      { path: '../escape.html', content: 'nope' },
    ],
  });
  assert.equal(badPath.result.isError, true);
  assert.match(textOf(badPath.result), /\.\./);
  // The rejected site must not have been created at all, not merely have had the
  // offending file dropped.
  assert.equal(await h.db.first('SELECT id FROM sites WHERE slug = ?', 'bad-path'), undefined);
});

test('duplicate slug with if_exists:fail is rejected, otherwise it versions', async () => {
  const failing = await callTool(h.baseUrl, API_TOKEN, 'site_publish', { visibility: 'public', confirm_public: true,
    slug: 'hello',
    html: '<p>v2</p>',
    if_exists: 'fail',
  });
  assert.equal(failing.result.isError, true);
  assert.match(textOf(failing.result), /already exists/);

  const ok = await callTool(h.baseUrl, API_TOKEN, 'site_publish', { visibility: 'public', confirm_public: true, slug: 'hello', html: '<p>v2 body</p>' });
  assert.equal(structured(ok.result).created, false);
  assert.match(await (await fetch(`${h.baseUrl}/s/hello/`)).text(), /v2 body/);
});

test('slug is derived from the title when omitted', async () => {
  const { result } = await callTool(h.baseUrl, API_TOKEN, 'site_publish', { visibility: 'public', confirm_public: true,
    title: 'Q3 Revenue Report',
    html: '<p>numbers</p>',
  });
  assert.equal(structured(result).slug, 'q3-revenue-report');
});

test('site_update_files carries files over and can remove them', async () => {
  const updated = await callTool(h.baseUrl, API_TOKEN, 'site_update_files', {
    slug: 'multi',
    upsert: [{ path: 'index.html', content: '<p>index v2</p>' }],
    remove: ['assets/app.css'],
    note: 'tweak',
  });
  assert.equal(updated.result.isError, undefined);

  assert.match(await (await fetch(`${h.baseUrl}/s/multi/`)).text(), /index v2/);
  assert.equal((await fetch(`${h.baseUrl}/s/multi/assets/app.css`)).status, 404);
  assert.equal((await fetch(`${h.baseUrl}/s/multi/img/dot.png`)).status, 200);

  const bogus = await callTool(h.baseUrl, API_TOKEN, 'site_update_files', {
    slug: 'multi',
    remove: ['not-there.css'],
  });
  assert.equal(bogus.result.isError, true);
  assert.match(textOf(bogus.result), /not in the current version/);
});

test('site_read_file returns text and base64 content', async () => {
  const html = await callTool(h.baseUrl, API_TOKEN, 'site_read_file', { slug: 'multi', path: 'index.html' });
  assert.equal(structured(html.result).encoding, 'utf8');
  assert.match(structured(html.result).content, /index v2/);

  const png = await callTool(h.baseUrl, API_TOKEN, 'site_read_file', { slug: 'multi', path: 'img/dot.png' });
  assert.equal(structured(png.result).encoding, 'base64');

  const missing = await callTool(h.baseUrl, API_TOKEN, 'site_read_file', { slug: 'multi', path: 'ghost.txt' });
  assert.equal(missing.result.isError, true);
  assert.match(textOf(missing.result), /Files:/);
});

test('site_list pages and reports totals', async () => {
  const first = await callTool(h.baseUrl, API_TOKEN, 'site_list', { limit: 2, offset: 0 });
  const data = structured(first.result);
  assert.equal(data.count, 2);
  assert.ok(data.total >= 3);
  assert.equal(data.has_more, true);
  assert.equal(data.next_offset, 2);
});

test('versions are retained up to the limit, then pruned; rollback works', async () => {
  for (const n of [3, 4, 5]) {
    await callTool(h.baseUrl, API_TOKEN, 'site_publish', { visibility: 'public', confirm_public: true, slug: 'hello', html: `<p>v${n} body</p>` });
  }
  const versions = await callTool(h.baseUrl, API_TOKEN, 'site_list_versions', { slug: 'hello' });
  const list = structured(versions.result).versions;
  assert.equal(list.length, 3, 'A2W_KEEP_VERSIONS=3 should cap retained versions');

  const target = list[1].version_id;
  const rolled = await callTool(h.baseUrl, API_TOKEN, 'site_rollback', { slug: 'hello', version_id: target });
  assert.equal(structured(rolled.result).current_version_id, target);
  assert.match(await (await fetch(`${h.baseUrl}/s/hello/`)).text(), /v4 body/);

  const gone = await callTool(h.baseUrl, API_TOKEN, 'site_rollback', { slug: 'hello', version_id: 'nosuchversion' });
  assert.equal(gone.result.isError, true);
  assert.match(textOf(gone.result), /Recent versions/);
});

test('rename changes the URL and frees the old slug', async () => {
  await callTool(h.baseUrl, API_TOKEN, 'site_publish', { visibility: 'public', confirm_public: true, slug: 'temp-name', html: '<p>renamed</p>' });
  const renamed = await callTool(h.baseUrl, API_TOKEN, 'site_rename', {
    slug: 'temp-name',
    new_slug: 'final-name',
    title: 'Final',
  });
  assert.equal(structured(renamed.result).slug, 'final-name');
  assert.equal((await fetch(`${h.baseUrl}/s/temp-name/`)).status, 404);
  assert.equal((await fetch(`${h.baseUrl}/s/final-name/`)).status, 200);

  const clash = await callTool(h.baseUrl, API_TOKEN, 'site_rename', { slug: 'final-name', new_slug: 'hello' });
  assert.equal(clash.result.isError, true);
  assert.match(textOf(clash.result), /taken/);
});

test('custom domains resolve by Host header', async () => {
  const set = await callTool(h.baseUrl, API_TOKEN, 'site_set_domain', {
    slug: 'final-name',
    domain: 'Reports.Example.Test',
  });
  assert.equal(structured(set.result).custom_domain, 'reports.example.test');
  assert.equal(structured(set.result).urls.custom, `http://reports.example.test:${h.port}/`);
  assert.match(textOf(set.result), /CNAME/);

  const res = await rawRequest(h.port, '/', { host: 'reports.example.test' });
  assert.equal(res.status, 200);
  assert.match(res.body, /renamed/);

  const dup = await callTool(h.baseUrl, API_TOKEN, 'site_set_domain', { slug: 'hello', domain: 'reports.example.test' });
  assert.equal(dup.result.isError, true);

  const appHost = await callTool(h.baseUrl, API_TOKEN, 'site_set_domain', {
    slug: 'hello',
    domain: '127.0.0.1',
  });
  assert.equal(appHost.result.isError, true);

  const cleared = await callTool(h.baseUrl, API_TOKEN, 'site_set_domain', { slug: 'final-name' });
  assert.equal(structured(cleared.result).custom_domain, null);
  // An unclaimed hostname is no longer a site: it falls through to the app itself.
  const afterClear = await rawRequest(h.port, '/', { host: 'reports.example.test' });
  assert.doesNotMatch(afterClear.body, /renamed/);
  assert.match(afterClear.body, /MCP endpoint/);
});

// Whether the bytes themselves go is asserted in storage.test.ts.
test('delete requires confirmation and cascades in the database', async () => {
  const site = structured((await callTool(h.baseUrl, API_TOKEN, 'site_get', { slug: 'final-name' })).result);
  const wrong = await callTool(h.baseUrl, API_TOKEN, 'site_delete', { slug: 'final-name', confirm_slug: 'nope' });
  assert.equal(wrong.result.isError, true);
  assert.match(textOf(wrong.result), /must exactly match/);

  const ok = await callTool(h.baseUrl, API_TOKEN, 'site_delete', {
    slug: 'final-name',
    confirm_slug: 'final-name',
  });
  assert.equal(structured(ok.result).deleted, true);
  assert.equal((await fetch(`${h.baseUrl}/s/final-name/`)).status, 404);
  // Deleting the site cascades: no version rows survive it.
  const orphans = await h.db.all('SELECT id FROM versions WHERE site_id NOT IN (SELECT id FROM sites)');
  assert.equal(orphans.length, 0);
});

test('unknown slug errors list known slugs', async () => {
  const res = await callTool(h.baseUrl, API_TOKEN, 'site_get', { slug: 'does-not-exist' });
  assert.equal(res.result.isError, true);
  assert.match(textOf(res.result), /Known slugs include/);
});
