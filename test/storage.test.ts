import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { API_TOKEN, blobKeys, callTool, startHarness, structured, type Harness } from './helpers.js';

/**
 * What happens to the bytes.
 *
 * The rest of the suite asserts through the HTTP surface, which cannot see the
 * difference between a version that was deleted and one that merely stopped
 * being listed. Storage that only *looks* cleaned up still costs money and
 * still holds content someone asked to have removed, so these tests read the
 * bucket directly.
 */

let h: Harness;

before(async () => {
  h = await startHarness({ A2W_KEEP_VERSIONS: '2' });
});
after(async () => h.close());

async function siteId(slug: string): Promise<string> {
  const row = await h.db.first<{ id: string }>('SELECT id FROM sites WHERE slug = ?', slug);
  assert.ok(row, `no site row for ${slug}`);
  return row.id;
}

async function publish(slug: string, files: Record<string, string>, note?: string) {
  const { result } = await callTool(h.baseUrl, API_TOKEN, 'site_publish', { visibility: 'public', confirm_public: true,
    slug,
    note,
    if_exists: 'new_version',
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return structured(result).version.version_id as string;
}

test('pruning an old version deletes its objects, not just its row', async () => {
  const v1 = await publish('prune-me', {
    'index.html': '<p>v1</p>',
    'app.js': 'console.log(1)',
  });
  const v2 = await publish('prune-me', { 'index.html': '<p>v2</p>', 'app.js': 'console.log(2)' });
  const id = await siteId('prune-me');

  assert.equal((await blobKeys(h, `sites/${id}/${v1}/`)).length, 2);

  // A2W_KEEP_VERSIONS=2, so this third publish evicts v1.
  const v3 = await publish('prune-me', { 'index.html': '<p>v3</p>', 'app.js': 'console.log(3)' });

  assert.deepEqual(
    await blobKeys(h, `sites/${id}/${v1}/`),
    [],
    'the evicted version left its bytes in the bucket',
  );
  assert.equal((await blobKeys(h, `sites/${id}/${v2}/`)).length, 2, 'prune took a kept version');
  assert.equal((await blobKeys(h, `sites/${id}/${v3}/`)).length, 2);
  assert.equal(
    (await blobKeys(h, `sites/${id}/`)).length,
    4,
    'the site should hold exactly the two retained versions',
  );
});

test('a version that survives pruning is still served in full', async () => {
  // Deletion is by key prefix, which is where an off-by-one quietly takes the
  // neighbouring version with it. Rolling back proves the survivor is intact.
  const versions = structured(
    (await callTool(h.baseUrl, API_TOKEN, 'site_list_versions', { slug: 'prune-me' })).result,
  ).versions;
  const oldest = versions[versions.length - 1].version_id;

  const rolled = await callTool(h.baseUrl, API_TOKEN, 'site_rollback', {
    slug: 'prune-me',
    version_id: oldest,
  });
  assert.equal(structured(rolled.result).current_version_id, oldest);

  assert.match(await (await fetch(`${h.baseUrl}/s/prune-me/`)).text(), /v2/);
  const asset = await fetch(`${h.baseUrl}/s/prune-me/app.js`);
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /console\.log\(2\)/);
});

test('deleting a site removes every object it owned', async () => {
  await publish('delete-me', {
    'index.html': '<p>bye</p>',
    'style.css': 'body{}',
    'assets/logo.svg': '<svg/>',
  });
  await publish('delete-me', { 'index.html': '<p>bye again</p>' });
  const id = await siteId('delete-me');
  assert.ok((await blobKeys(h, `sites/${id}/`)).length >= 4);

  // A neighbour that must be untouched by the delete.
  await publish('bystander', { 'index.html': '<p>still here</p>' });
  const bystander = await siteId('bystander');

  const ok = await callTool(h.baseUrl, API_TOKEN, 'site_delete', {
    slug: 'delete-me',
    confirm_slug: 'delete-me',
  });
  assert.equal(structured(ok.result).deleted, true);

  assert.deepEqual(
    await blobKeys(h, `sites/${id}/`),
    [],
    'deleting the site left its bytes in the bucket',
  );
  assert.equal((await blobKeys(h, `sites/${bystander}/`)).length, 1, 'delete hit a neighbour');
  assert.equal((await fetch(`${h.baseUrl}/s/bystander/`)).status, 200);
});

test('site_update_files does not carry a removed file into the new version', async () => {
  await publish('trimmed', { 'index.html': '<p>keep</p>', 'gone.txt': 'delete me' });
  const id = await siteId('trimmed');

  const res = await callTool(h.baseUrl, API_TOKEN, 'site_update_files', {
    slug: 'trimmed',
    remove: ['gone.txt'],
  });
  assert.notEqual(res.result.isError, true);
  const newVersion = structured(res.result).version.version_id;

  assert.deepEqual(await blobKeys(h, `sites/${id}/${newVersion}/`), [
    `sites/${id}/${newVersion}/index.html`,
  ]);
  assert.equal((await fetch(`${h.baseUrl}/s/trimmed/gone.txt`)).status, 404);
});

test('the bucket and the database agree: no orphans in either direction', async () => {
  // Runs last, over everything the file has published, rolled back and deleted.
  const rows = await h.db.all<{ site_id: string; version_id: string; path: string }>(
    `SELECT v.site_id, f.version_id, f.path
       FROM files f
       JOIN versions v ON v.id = f.version_id
       JOIN sites s ON s.id = v.site_id`,
  );
  const expected = rows.map(r => `sites/${r.site_id}/${r.version_id}/${r.path}`).sort();
  const actual = await blobKeys(h, 'sites/');

  assert.deepEqual(actual, expected);

  const danglingVersions = await h.db.all(
    'SELECT id FROM versions WHERE site_id NOT IN (SELECT id FROM sites)',
  );
  assert.equal(danglingVersions.length, 0);
  const danglingFiles = await h.db.all(
    'SELECT path FROM files WHERE version_id NOT IN (SELECT id FROM versions)',
  );
  assert.equal(danglingFiles.length, 0);
});
