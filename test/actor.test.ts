import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { ADMIN_PASSWORD, API_TOKEN, callTool, startHarness, structured, textOf, type Harness } from './helpers.js';

// Backlog #16: every version records who created it.

let h: Harness;

before(async () => {
  h = await startHarness();
});
after(async () => h.close());

test('versions created with the API token record it, through every write path', async () => {
  const call = (name: string, args: Record<string, unknown>) =>
    callTool(h.baseUrl, API_TOKEN, name, args).then(r => r.result);
  for (const [name, args] of [
    ['site_publish', { slug: 'who', html: '<style>a{}</style><p>1</p>' }],
    ['site_update_files', { slug: 'who', upsert: [{ path: 'b.txt', content: 'b' }] }],
    ['site_edit_file', { slug: 'who', edits: [{ old_text: '<p>1</p>', new_text: '<p>2</p>' }] }],
    ['site_extract_file', { slug: 'who', extractions: [{ to: 'a.css', start: '<style>', end: '</style>', replace_with: '' }] }],
  ] as const) {
    const res = await call(name, args);
    assert.notEqual(res.isError, true, `${name}: ${textOf(res)}`);
  }
  const versions = structured(await call('site_list_versions', { slug: 'who' })).versions;
  assert.equal(versions.length, 4);
  for (const v of versions) assert.deepEqual(v.created_by, { id: 'api-token', label: 'static API token' });
  assert.match(textOf(await call('site_list_versions', { slug: 'who' })), /by static API token \(api-token\)/);
});

test('the admin site page shows who created each version', async () => {
  const login = await fetch(`${h.baseUrl}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: ADMIN_PASSWORD }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  const page = await (await fetch(`${h.baseUrl}/admin/sites/who`, { headers: { cookie } })).text();
  assert.match(page, /<th>By<\/th>/);
  assert.match(page, /static API token/);
});

test('versions from before the column existed show no author rather than failing', async () => {
  await callTool(h.baseUrl, API_TOKEN, 'site_publish', { slug: 'old', html: '<p>old</p>' });
  await h.db.run(`UPDATE versions SET actor = NULL, actor_label = NULL`);
  const res = await callTool(h.baseUrl, API_TOKEN, 'site_list_versions', { slug: 'old' });
  assert.equal(structured(res.result).versions[0].created_by, null);
  assert.doesNotMatch(textOf(res.result), / by /);
});
