import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { API_TOKEN, callTool, startHarness, structured, textOf, type Harness } from './helpers.js';

// Agents cap one tool call at roughly 40 KB of arguments, far under the per-file
// limit. These tests pin the two ways around it: edit in place, or stage in chunks.

let h: Harness;

before(async () => {
  h = await startHarness();
});
after(async () => h.close());

const call = (name: string, args: Record<string, unknown>) =>
  callTool(h.baseUrl, API_TOKEN, name, args).then(r => r.result);

async function body(slug: string, path = ''): Promise<string> {
  const res = await fetch(`${h.baseUrl}/s/${slug}/${path}`);
  return res.text();
}

// A page bigger than any single call an agent could send.
const bigPage = `<!doctype html><title>Big</title><h1>Otsikko</h1>${'<p>Lorem ipsum ä ö å.</p>'.repeat(
  3000,
)}<footer>loppu</footer>`;

test('a large page staged in chunks publishes whole, and nothing goes live until then', async () => {
  const chunks = bigPage.match(/[\s\S]{1,20000}/g)!;
  assert.ok(chunks.length > 3);
  for (const [i, chunk] of chunks.entries()) {
    const res = await call('site_stage_file', {
      slug: 'chunked',
      path: 'index.html',
      content: chunk,
      append: i > 0,
    });
    assert.notEqual(res.isError, true, textOf(res));
  }
  assert.equal((await fetch(`${h.baseUrl}/s/chunked/`)).status, 404);

  const pub = await call('site_publish', {
    slug: 'chunked',
    staged: ['index.html'],
    visibility: 'public',
    confirm_public: true,
  });
  assert.notEqual(pub.isError, true, textOf(pub));
  assert.equal(await body('chunked'), bigPage);

  // Staging is consumed by the publish.
  const again = await call('site_update_files', { slug: 'chunked', staged: ['index.html'] });
  assert.equal(again.isError, true);
  assert.match(textOf(again), /not staged/);
});

test('staged files update an existing site and keep the others', async () => {
  await call('site_publish', {
    slug: 'mixed',
    files: [
      { path: 'index.html', content: '<p>old</p>' },
      { path: 'about.html', content: '<p>about</p>' },
    ],
    visibility: 'public',
    confirm_public: true,
  });
  await call('site_stage_file', { slug: 'mixed', path: 'index.html', content: '<p>new ' });
  await call('site_stage_file', { slug: 'mixed', path: 'index.html', content: 'page</p>', append: true });
  const res = await call('site_update_files', { slug: 'mixed', staged: ['index.html'] });
  assert.notEqual(res.isError, true, textOf(res));
  assert.equal(await body('mixed'), '<p>new page</p>');
  assert.equal(await body('mixed', 'about.html'), '<p>about</p>');
});

test('appending needs a first chunk, and base64 chunks must split on 4-character boundaries', async () => {
  const orphan = await call('site_stage_file', { slug: 'nothing', path: 'a.html', content: 'x', append: true });
  assert.equal(orphan.isError, true);
  assert.match(textOf(orphan), /append:false/);

  const ragged = await call('site_stage_file', {
    slug: 'nothing',
    path: 'img.png',
    content: 'QUJ',
    encoding: 'base64',
  });
  assert.equal(ragged.isError, true);
  assert.match(textOf(ragged), /multiple of 4/);
});

test('site_edit_file changes only the matched text of a large page', async () => {
  // Assemble the big page first; the edit itself is a few bytes.
  const chunks = bigPage.match(/[\s\S]{1,20000}/g)!;
  for (const [i, chunk] of chunks.entries()) {
    await call('site_stage_file', { slug: 'edited', path: 'index.html', content: chunk, append: i > 0 });
  }
  await call('site_publish', { slug: 'edited', staged: ['index.html'], visibility: 'public', confirm_public: true });

  const res = await call('site_edit_file', {
    slug: 'edited',
    edits: [
      { old_text: '<h1>Otsikko</h1>', new_text: '<h1>Uusi $& otsikko</h1>' },
      { old_text: 'loppu', new_text: 'the end' },
    ],
    note: 'retitle',
  });
  assert.notEqual(res.isError, true, textOf(res));
  assert.equal(
    await body('edited'),
    bigPage.replace('<h1>Otsikko</h1>', () => '<h1>Uusi $& otsikko</h1>').replace('loppu', 'the end'),
  );
  assert.equal(structured(res).version.note, 'retitle');
});

test('a failing edit publishes nothing', async () => {
  const prior = await call('site_list_versions', { slug: 'edited' });
  const ambiguous = await call('site_edit_file', {
    slug: 'edited',
    edits: [
      { old_text: 'the end', new_text: 'fine' },
      { old_text: '<p>Lorem', new_text: '<p>Ipsum' },
    ],
  });
  assert.equal(ambiguous.isError, true);
  assert.match(textOf(ambiguous), /Edit 2: .*occurs 3000 times/);

  const missing = await call('site_edit_file', { slug: 'edited', edits: [{ old_text: 'nope', new_text: 'x' }] });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /not found/);

  const afterward = await call('site_list_versions', { slug: 'edited' });
  assert.equal(structured(afterward).count, structured(prior).count);
  assert.match(await body('edited'), /the end/);
});

test('replace_all rewrites every occurrence', async () => {
  const res = await call('site_edit_file', {
    slug: 'edited',
    edits: [{ old_text: 'Lorem ipsum', new_text: 'Dolor', replace_all: true }],
  });
  assert.notEqual(res.isError, true, textOf(res));
  const text = await body('edited');
  assert.doesNotMatch(text, /Lorem ipsum/);
  assert.equal(text.split('Dolor').length - 1, 3000);
});
