import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import type { Config } from '../src/core/config.js';
import { WebCryptoProvider } from '../src/core/crypto.js';
import { SiteStore } from '../src/store.js';
import { API_TOKEN, blobKeys, callTool, startHarness, structured, textOf, type Harness } from './helpers.js';

// Backlog #70: a write can say which version it was based on, and is refused
// if the site has moved on since, so two editors cannot overwrite each other.

let h: Harness;

before(async () => {
  h = await startHarness();
});
after(async () => h.close());

const call = (name: string, args: Record<string, unknown>) =>
  callTool(h.baseUrl, API_TOKEN, name, args).then(r => r.result);

async function site(slug: string): Promise<{ v1: string; v2: string }> {
  const first = await call('site_publish', { slug, html: '<style>a{}</style><p>one</p>' });
  assert.notEqual(first.isError, true, textOf(first));
  const second = await call('site_update_files', { slug, upsert: [{ path: 'extra.txt', content: 'x' }] });
  assert.notEqual(second.isError, true, textOf(second));
  return { v1: structured(first).version.version_id, v2: structured(second).version.version_id };
}

async function versionCount(slug: string): Promise<number> {
  return structured(await call('site_list_versions', { slug })).count;
}

// One stale write per tool: a tool that drops the argument lets it through.
const WRITES: [string, Record<string, unknown>][] = [
  ['site_update_files', { upsert: [{ path: 'b.txt', content: 'b' }] }],
  ['site_edit_file', { edits: [{ old_text: '<p>one</p>', new_text: '<p>two</p>' }] }],
  ['site_extract_file', { extractions: [{ to: 'a.css', start: '<style>', end: '</style>', replace_with: '' }] }],
  ['site_publish', { html: '<p>replaced</p>' }],
];

for (const [tool, args] of WRITES) {
  test(`${tool} refuses a stale if_version, names who moved the site, and publishes nothing`, async () => {
    const slug = `stale-${tool.replace(/_/g, '-')}`;
    const { v1, v2 } = await site(slug);
    const res = await call(tool, { slug, ...args, if_version: v1 });
    assert.equal(res.isError, true, `${tool} accepted a stale if_version`);
    const text = textOf(res);
    assert.ok(text.includes(v2), `the error names the live version: ${text}`);
    assert.match(text, /static API token/);
    assert.equal(await versionCount(slug), 2);
  });
}

for (const [tool, args] of WRITES) {
  test(`${tool} accepts an if_version that matches the live version`, async () => {
    const slug = `fresh-${tool.replace(/_/g, '-')}`;
    const { v2 } = await site(slug);
    const res = await call(tool, { slug, ...args, if_version: v2 });
    assert.notEqual(res.isError, true, textOf(res));
    assert.equal(await versionCount(slug), 3);
  });
}

test('a write that lands between the check and the commit wins, and the stale one leaves nothing behind', async () => {
  // Deterministic race: the store under test pauses at its first object write
  // (after the if_version check has passed) while a second writer commits.
  // Without the compare-and-swap on the pointer, the stale write would still
  // win here and silently replace the competitor's version.
  const { v2 } = await site('race');
  const siteId = (await h.db.first<{ id: string }>('SELECT id FROM sites WHERE slug = ?', 'race'))!.id;
  const db = (await h.mf.getD1Database('DB')) as never;
  const bucket: any = await h.mf.getR2Bucket('BLOBS');
  const config = { maxFiles: 200, maxFileBytes: 5 << 20, maxSiteBytes: 25 << 20, keepVersions: 10 } as Config;
  const crypto = new WebCryptoProvider();
  const competitor = new SiteStore(db, bucket, config, crypto);

  let raced = false;
  const trapped = new Proxy(bucket, {
    get(target, prop) {
      if (prop !== 'put') return target[prop].bind(target);
      return async (...args: unknown[]) => {
        if (!raced) {
          raced = true;
          await competitor.publish({ slug: 'race', files: [{ path: 'index.html', content: 'competitor' }] });
        }
        return target.put(...args);
      };
    },
  });
  const stale = new SiteStore(db, trapped, config, crypto);

  await assert.rejects(
    // Full publishes carry no files, so the store runs here in Node without
    // the Workers-only FixedLengthStream.
    stale.publish({ slug: 'race', files: [{ path: 'index.html', content: 'stale' }], ifVersion: v2 }),
    /has moved on/,
  );
  assert.ok(raced, 'the race was not exercised');

  const live = await h.db.first<{ current_version_id: string }>('SELECT current_version_id FROM sites WHERE id = ?', siteId);
  const files = await h.db.all<{ path: string }>('SELECT path FROM files WHERE version_id = ? ORDER BY path', live!.current_version_id);
  assert.deepEqual(files.map(f => f.path), ['index.html']);
  assert.equal(structured(await call('site_read_file', { slug: 'race', path: 'index.html' })).content, 'competitor');
  assert.equal(await versionCount('race'), 3);

  const retained = new Set((await h.db.all<{ id: string }>('SELECT id FROM versions WHERE site_id = ?', siteId)).map(r => r.id));
  for (const key of await blobKeys(h, `sites/${siteId}/`)) {
    assert.ok(retained.has(key.split('/')[2]!), `orphaned object from the stale write: ${key}`);
  }
});

test('without if_version, writes behave exactly as before', async () => {
  const { v1 } = await site('unconditional');
  assert.ok(v1);
  const res = await call('site_update_files', { slug: 'unconditional', upsert: [{ path: 'c.txt', content: 'c' }] });
  assert.notEqual(res.isError, true, textOf(res));
});

test('a stale edit is refused as a conflict even when the other writer changed the edited text', async () => {
  // Review finding: the edit used to be applied to the live file first, so the
  // agent got "old_text was not found" and never learned someone else edited.
  const first = await call('site_publish', { slug: 'edit-race', html: '<style>a{}</style><p>one</p>' });
  const v1 = structured(first).version.version_id;
  await call('site_edit_file', { slug: 'edit-race', edits: [{ old_text: '<p>one</p>', new_text: '<p>theirs</p>' }] });
  for (const [tool, args] of [
    ['site_edit_file', { edits: [{ old_text: '<p>one</p>', new_text: '<p>mine</p>' }] }],
    ['site_extract_file', { extractions: [{ to: 'x.css', start: '<p>one', end: '</p>', replace_with: '' }] }],
  ] as const) {
    const res = await call(tool, { slug: 'edit-race', ...args, if_version: v1 });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /has moved on/, `${tool}: ${textOf(res)}`);
  }
});

test('if_version on a publish without a slug says so plainly', async () => {
  const res = await call('site_publish', { html: '<p>x</p>', if_version: 'abc' });
  assert.equal(res.isError, true);
  assert.doesNotMatch(textOf(res), /undefined/);
});
