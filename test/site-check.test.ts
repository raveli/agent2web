import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { API_TOKEN, callTool, startHarness, structured, textOf, type Harness } from './helpers.js';

// Backlog #71: one call tells an agent whether its site is complete, and gives
// the hashes to compare against its local files instead of re-reading them.

let h: Harness;

before(async () => {
  h = await startHarness();
});
after(async () => h.close());

const call = (name: string, args: Record<string, unknown>) =>
  callTool(h.baseUrl, API_TOKEN, name, args).then(r => r.result);

const INDEX = '<link rel="stylesheet" href="styles.css"><script src="app.js"></script><p>ä</p>';
const STYLES = 'body{background:url(bg.png)}';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

// Public unless a test says otherwise: a locked site in this harness has only a
// path URL, where the separate files would not load, and check says so.
async function publish(slug: string, extra: Record<string, unknown> = { visibility: 'public', confirm_public: true }) {
  const res = await call('site_publish', {
    slug,
    files: [
      { path: 'index.html', content: INDEX },
      { path: 'styles.css', content: STYLES },
      { path: 'app.js', content: 'console.log(1)' },
      { path: 'bg.png', content: 'png' },
    ],
    ...extra,
  });
  assert.notEqual(res.isError, true, textOf(res));
  return structured(res).version.version_id as string;
}

test('a complete site checks out, with each file\'s size, type and sha256', async () => {
  await publish('complete');
  const res = await call('site_check', { slug: 'complete' });
  assert.notEqual(res.isError, true, textOf(res));
  const data = structured(res);
  assert.equal(data.ok, true);
  assert.equal(data.has_index, true);
  assert.deepEqual(data.missing, []);
  const index = data.files.find((f: any) => f.path === 'index.html');
  assert.equal(index.sha256, sha(INDEX));
  assert.equal(index.bytes, Buffer.byteLength(INDEX));
  assert.match(index.content_type, /text\/html/);
  assert.equal(data.files.find((f: any) => f.path === 'styles.css').sha256, sha(STYLES));
  assert.match(textOf(res), /no missing references/i);
});

test('a file removed after a split is reported, with the page that needs it', async () => {
  await publish('broken');
  await call('site_update_files', { slug: 'broken', remove: ['app.js', 'bg.png'] });
  const res = await call('site_check', { slug: 'broken' });
  const data = structured(res);
  assert.equal(data.ok, false);
  assert.deepEqual(data.missing, [
    { file: 'index.html', reference: 'app.js', resolved: 'app.js' },
    { file: 'styles.css', reference: 'bg.png', resolved: 'bg.png' },
  ]);
  assert.match(textOf(res), /index\.html → app\.js/);
});

test('an earlier version can be checked by id', async () => {
  const v1 = await publish('history');
  await call('site_update_files', { slug: 'history', remove: ['app.js'] });
  assert.equal(structured(await call('site_check', { slug: 'history' })).ok, false);
  const earlier = structured(await call('site_check', { slug: 'history', version_id: v1 }));
  assert.equal(earlier.ok, true);
  assert.equal(earlier.version_id, v1);
});

test('a locked site with separate files and no hostname of its own is not ok, and says why', async () => {
  // This harness has no A2W_SITES_BASE_DOMAIN, so the site only has a path URL.
  await publish('locked-path', { password: 'check-password-1' });
  const data = structured(await call('site_check', { slug: 'locked-path' }));
  assert.deepEqual(data.missing, []);
  assert.equal(data.ok, false);
  assert.match(data.warnings.join(' '), /will not load/);
});
