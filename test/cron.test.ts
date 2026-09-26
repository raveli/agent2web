import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { purgeStaging, STAGING_MAX_AGE_MS } from '../src/store.js';
import { API_TOKEN, blobKeys, callTool, startHarness, textOf, type Harness } from './helpers.js';

// Backlog #72 (abandoned uploads) and #13 (a cron that fails loudly, per job).

let h: Harness;

before(async () => {
  h = await startHarness();
});
after(async () => h.close());

async function stage(slug: string, path: string) {
  const res = await callTool(h.baseUrl, API_TOKEN, 'site_stage_file', { slug, path, content: 'chunk' });
  assert.notEqual(res.result.isError, true, textOf(res.result));
}

test('uploads staged over a day ago are purged, fresh ones and published sites are kept', async () => {
  await callTool(h.baseUrl, API_TOKEN, 'site_publish', {
    slug: 'kept',
    html: '<p>kept</p>',
    visibility: 'public',
    confirm_public: true,
  });
  await stage('abandoned', 'index.html');
  await stage('abandoned', 'app.js');

  const bucket = (await h.mf.getR2Bucket('BLOBS')) as never;
  assert.equal(await purgeStaging(bucket), 0, 'fresh uploads survive');
  assert.equal((await blobKeys(h, 'staging/')).length, 2);

  const aDayLater = Date.now() + STAGING_MAX_AGE_MS + 60_000;
  assert.equal(await purgeStaging(bucket, aDayLater), 2);
  assert.deepEqual(await blobKeys(h, 'staging/'), []);
  assert.equal((await blobKeys(h, 'sites/')).length, 1, 'published files are never touched');
});

test('the scheduled handler runs every job without throwing', async () => {
  await stage('fresh', 'index.html');
  const worker = await h.mf.getWorker();
  const result = await (worker as any).scheduled({ cron: '0 4 * * *', scheduledTime: new Date() });
  assert.equal(result.outcome, 'ok');
  assert.equal((await blobKeys(h, 'staging/')).length, 1, 'a fresh upload survives the nightly run');
});
