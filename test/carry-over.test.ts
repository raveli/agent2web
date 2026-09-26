import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { API_TOKEN, blobKeys, callTool, startHarness, structured, textOf, type Harness } from './helpers.js';

/**
 * Files an update does not mention are carried into the new version.
 *
 * Backlog #2: a carried file whose object had gone missing used to be skipped,
 * and the update reported success with one file fewer. Backlog #15: carrying
 * used to read every file into memory and base64 it twice over; it now copies
 * object to object, so these tests pin that the bytes and their labels survive.
 */

let h: Harness;

before(async () => {
  h = await startHarness();
});
after(async () => h.close());

const call = (name: string, args: Record<string, unknown>) =>
  callTool(h.baseUrl, API_TOKEN, name, args).then(r => r.result);

async function publish(slug: string, files: { path: string; content: string; encoding?: string }[]) {
  const res = await call('site_publish', { slug, files, visibility: 'public', confirm_public: true });
  assert.notEqual(res.isError, true, textOf(res));
  return structured(res);
}

async function fetchBytes(slug: string, path: string) {
  const res = await fetch(`${h.baseUrl}/s/${slug}/${path}`);
  return { status: res.status, type: res.headers.get('content-type') ?? '', bytes: new Uint8Array(await res.arrayBuffer()) };
}

test('an update whose carried file has vanished from storage fails and publishes nothing', async () => {
  const published = await publish('vanished', [
    { path: 'index.html', content: '<p>home</p>' },
    { path: 'about.html', content: '<p>about</p>' },
  ]);
  const siteId = (await h.db.first<{ id: string }>('SELECT id FROM sites WHERE slug = ?', 'vanished'))!.id;
  const bucket = await h.mf.getR2Bucket('BLOBS');
  await bucket.delete(`sites/${siteId}/${published.current_version_id}/about.html`);

  const res = await call('site_update_files', {
    slug: 'vanished',
    upsert: [{ path: 'index.html', content: '<p>home v2</p>' }],
  });
  assert.equal(res.isError, true, 'the update must not report success');
  assert.match(textOf(res), /about\.html/);
  assert.match(textOf(res), /site_rollback|rollback/);

  const versions = structured(await call('site_list_versions', { slug: 'vanished' }));
  assert.equal(versions.count, 1);
  assert.equal(versions.current_version_id, published.current_version_id);
  // The failed attempt leaves no half-written version behind in the bucket.
  assert.deepEqual(
    (await blobKeys(h, `sites/${siteId}/`)).filter(k => !k.includes(published.current_version_id)),
    [],
  );
});

test('carried files keep their exact bytes and content type, binary included', async () => {
  const png = new Uint8Array(3 * 1024 * 1024);
  for (let i = 0; i < png.length; i++) png[i] = (i * 31 + 7) & 0xff;
  png.set([0x89, 0x50, 0x4e, 0x47], 0);
  let binary = '';
  for (const b of png) binary += String.fromCharCode(b);

  await publish('carried', [
    { path: 'index.html', content: '<p>v1</p>' },
    { path: 'img/big.png', content: btoa(binary), encoding: 'base64' },
    { path: 'data.json', content: '{"ä":"ö"}' },
  ]);

  for (const n of [2, 3]) {
    const res = await call('site_update_files', {
      slug: 'carried',
      upsert: [{ path: 'index.html', content: `<p>v${n}</p>` }],
    });
    assert.notEqual(res.isError, true, textOf(res));
    assert.equal(structured(res).version.file_count, 3);
    assert.equal(structured(res).version.bytes, 3 * 1024 * 1024 + '{"ä":"ö"}'.length + 2 + '<p>v2</p>'.length);
  }

  const img = await fetchBytes('carried', 'img/big.png');
  assert.equal(img.status, 200);
  assert.match(img.type, /image\/png/);
  assert.equal(img.bytes.length, png.length);
  assert.ok(img.bytes.every((b, i) => b === png[i]), 'carried binary changed');

  const json = await fetchBytes('carried', 'data.json');
  assert.match(json.type, /application\/json/);
  assert.equal(new TextDecoder().decode(json.bytes), '{"ä":"ö"}');
  assert.equal(new TextDecoder().decode((await fetchBytes('carried', '')).bytes), '<p>v3</p>');
});

test('removing and upserting still work alongside carried files', async () => {
  await publish('mixed-carry', [
    { path: 'index.html', content: 'i' },
    { path: 'a.css', content: 'a' },
    { path: 'b.js', content: 'b' },
  ]);
  const res = await call('site_update_files', {
    slug: 'mixed-carry',
    upsert: [{ path: 'c.txt', content: 'c' }],
    remove: ['b.js'],
  });
  assert.notEqual(res.isError, true, textOf(res));
  const files = structured(await call('site_get', { slug: 'mixed-carry' })).files.map((f: any) => f.path);
  assert.deepEqual(files, ['a.css', 'c.txt', 'index.html']);
  assert.equal((await fetchBytes('mixed-carry', 'b.js')).status, 404);
  assert.equal(new TextDecoder().decode((await fetchBytes('mixed-carry', 'a.css')).bytes), 'a');
});

test('carried files still count toward the site size limit', async () => {
  const limited = await startHarness({ A2W_MAX_SITE_BYTES: '2048' });
  try {
    const first = await callTool(limited.baseUrl, API_TOKEN, 'site_publish', {
      slug: 'full',
      visibility: 'public',
      confirm_public: true,
      files: [
        { path: 'index.html', content: 'x' },
        { path: 'big.txt', content: 'y'.repeat(1500) },
      ],
    });
    assert.notEqual(first.result.isError, true, textOf(first.result));
    const over = await callTool(limited.baseUrl, API_TOKEN, 'site_update_files', {
      slug: 'full',
      upsert: [{ path: 'more.txt', content: 'z'.repeat(1000) }],
    });
    assert.equal(over.result.isError, true);
    assert.match(textOf(over.result), /limit/);
  } finally {
    await limited.close();
  }
});
