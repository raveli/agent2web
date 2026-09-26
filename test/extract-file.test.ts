import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { API_TOKEN, callTool, startHarness, structured, textOf, type Harness } from './helpers.js';

// Splitting a page must not cost resending it: the text moves on the server.

let h: Harness;

before(async () => {
  h = await startHarness();
});
after(async () => h.close());

const call = (name: string, args: Record<string, unknown>) =>
  callTool(h.baseUrl, API_TOKEN, name, args).then(r => r.result);

async function body(slug: string, path = ''): Promise<{ status: number; text: string; type: string }> {
  const res = await fetch(`${h.baseUrl}/s/${slug}/${path}`);
  return { status: res.status, text: await res.text(), type: res.headers.get('content-type') ?? '' };
}

const CSS = '\n  body { color: red; }\n';
const DATA = '{"days":[1,2,3],"note":"ä ö $& </p>"}';
const JS = '\n  render(JSON.parse(document.getElementById("data").textContent));\n';
const PAGE =
  `<!doctype html><title>Portal</title><style>${CSS}</style>` +
  `<script type="application/json" id="data">${DATA}</script>` +
  `<main>hello</main><script>${JS}</script>`;

async function publish(slug: string) {
  const res = await call('site_publish', {
    slug,
    html: PAGE,
    visibility: 'public',
    confirm_public: true,
  });
  assert.notEqual(res.isError, true, textOf(res));
}

test('one call splits a page into CSS, data and JS files, byte for byte', async () => {
  await publish('split');
  const res = await call('site_extract_file', {
    slug: 'split',
    extractions: [
      { to: 'styles.css', start: '<style>', end: '</style>', replace_with: '<link rel="stylesheet" href="styles.css">' },
      {
        to: 'data.json',
        start: '<script type="application/json" id="data">',
        end: '</script>',
        replace_with: '',
      },
      { to: 'app.js', start: '<main>hello</main><script>', end: '</script>', replace_with: '<main>hello</main><script src="app.js"></script>' },
    ],
    note: 'split into modules',
  });
  assert.notEqual(res.isError, true, textOf(res));
  const data = structured(res);
  assert.equal(data.version.file_count, 4);
  assert.equal(data.version.note, 'split into modules');
  assert.deepEqual(
    data.extracted.map((f: any) => f.path),
    ['styles.css', 'data.json', 'app.js'],
  );

  assert.equal(
    (await body('split')).text,
    '<!doctype html><title>Portal</title><link rel="stylesheet" href="styles.css">' +
      '<main>hello</main><script src="app.js"></script>',
  );
  const css = await body('split', 'styles.css');
  assert.equal(css.text, CSS);
  assert.match(css.type, /text\/css/);
  const json = await body('split', 'data.json');
  assert.equal(json.text, DATA);
  assert.match(json.type, /application\/json/);
  assert.equal((await body('split', 'app.js')).text, JS);
});

test('the end marker is the first one after start, not the first in the file', async () => {
  await publish('first-end');
  const res = await call('site_extract_file', {
    slug: 'first-end',
    extractions: [{ to: 'app.js', start: '<main>hello</main><script>', end: '</script>', replace_with: '' }],
  });
  assert.notEqual(res.isError, true, textOf(res));
  assert.equal((await body('first-end', 'app.js')).text, JS);
});

test('a failing extraction publishes nothing, and says why', async () => {
  await publish('atomic');
  const versions = async () => structured(await call('site_list_versions', { slug: 'atomic' })).count;
  const before = await versions();

  const cases: [Record<string, unknown>, RegExp][] = [
    [{ to: 'a.css', start: '<nope>', end: '</style>', replace_with: '' }, /start was not found/],
    [{ to: 'a.js', start: '<script', end: '</script>', replace_with: '' }, /start occurs 2 times/],
    [{ to: 'a.css', start: '<main>', end: '</nope>', replace_with: '' }, /end was not found after start/],
    [{ to: 'index.html', start: '<main>', end: '</main>', replace_with: '' }, /must differ from the source/],
  ];
  for (const [extraction, message] of cases) {
    const res = await call('site_extract_file', {
      slug: 'atomic',
      extractions: [{ to: 'ok.css', start: '<style>', end: '</style>', replace_with: '' }, extraction],
    });
    assert.equal(res.isError, true, JSON.stringify(extraction));
    assert.match(textOf(res), message);
  }
  assert.equal(await versions(), before);
  assert.equal((await body('atomic')).text, PAGE);
});

test('an existing target file is protected unless overwrite is set', async () => {
  await call('site_publish', {
    slug: 'existing',
    files: [
      { path: 'index.html', content: '<style>new</style><p>x</p>' },
      { path: 'styles.css', content: 'old' },
    ],
    visibility: 'public',
    confirm_public: true,
  });
  const refused = await call('site_extract_file', {
    slug: 'existing',
    extractions: [{ to: 'styles.css', start: '<style>', end: '</style>', replace_with: '' }],
  });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /already exists/);
  assert.equal((await body('existing', 'styles.css')).text, 'old');

  const res = await call('site_extract_file', {
    slug: 'existing',
    overwrite: true,
    extractions: [{ to: 'styles.css', start: '<style>', end: '</style>', replace_with: '' }],
  });
  assert.notEqual(res.isError, true, textOf(res));
  assert.equal((await body('existing', 'styles.css')).text, 'new');
  assert.equal((await body('existing')).text, '<p>x</p>');
});
