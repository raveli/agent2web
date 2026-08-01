import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { API_TOKEN, callTool, rawRequest, startHarness, structured, textOf, type Harness } from './helpers.js';

/**
 * Password-protected sites and their subresources.
 *
 * A gated page is served with `Content-Security-Policy: sandbox`, which gives it
 * an opaque origin — and an opaque origin has no cookie access at all. Not just
 * `document.cookie`, which throws: its subresource requests carry no cookies
 * either, whatever SameSite says (verified against Chrome with Lax, None and
 * Strict decoys — the document got all three, the stylesheet got none).
 *
 * So every CSS, JS and image request on a gated path-based site arrives
 * unauthenticated and is denied. The denial used to be the HTML password page,
 * which browsers refuse to treat as a stylesheet or script and report as
 * ERR_BLOCKED_BY_ORB — an error that names neither the site nor the password.
 * These tests pin the two things we can fix: say what happened, and warn at
 * publish time before anyone hits it.
 */

let h: Harness;

before(async () => {
  h = await startHarness();
});
after(async () => h.close());

const FILES = [
  { path: 'index.html', content: '<link rel="stylesheet" href="app.css"><p>hello</p>' },
  { path: 'app.css', content: 'body{color:red}' },
  { path: 'app.js', content: 'console.log(1)' },
];

test('a denied subresource says so in plain text, not as an HTML page', async () => {
  await callTool(h.baseUrl, API_TOKEN, 'site_publish', {
    slug: 'gated', files: FILES, password: 'letmein-please',
  });

  const res = await rawRequest(h.port, '/s/gated/app.css', {
    headers: { 'sec-fetch-dest': 'style' },
  });
  assert.equal(res.status, 401);
  assert.ok(
    !String(res.headers['content-type']).includes('text/html'),
    `a stylesheet request must not be answered with HTML, got ${res.headers['content-type']}`,
  );
  assert.ok(!res.body.includes('<form'), 'the password form leaked into a subresource response');
  // The whole point: the message has to name the cause, because the browser will not.
  assert.match(res.body, /password/i);
  assert.match(res.body, /gated/);
});

test('scripts and images get the same treatment', async () => {
  for (const dest of ['script', 'image', 'font', 'audio', 'style']) {
    const res = await rawRequest(h.port, '/s/gated/app.js', { headers: { 'sec-fetch-dest': dest } });
    assert.equal(res.status, 401, dest);
    assert.ok(!String(res.headers['content-type']).includes('text/html'), dest);
  }
});

test('the document itself still gets the password form', async () => {
  const cases: Record<string, string>[] = [{ 'sec-fetch-dest': 'document' }, {}];
  for (const headers of cases) {
    const res = await rawRequest(h.port, '/s/gated/', { headers });
    assert.equal(res.status, 401);
    assert.match(String(res.headers['content-type']), /text\/html/);
    assert.match(res.body, /<form/, 'the owner must still be able to type the password');
  }
});

test('an iframed document gets the form too, not the plain-text refusal', async () => {
  const res = await rawRequest(h.port, '/s/gated/', { headers: { 'sec-fetch-dest': 'iframe' } });
  assert.equal(res.status, 401);
  assert.match(res.body, /<form/);
});

test('publishing a gated site with subresources warns about it', async () => {
  const { result } = await callTool(h.baseUrl, API_TOKEN, 'site_publish', {
    slug: 'gated-warn', files: FILES, password: 'letmein-please',
  });
  assert.notEqual(result.isError, true);

  const warnings = structured(result).warnings;
  assert.ok(Array.isArray(warnings) && warnings.length > 0, 'expected a warnings array');
  const joined = warnings.join(' ');
  assert.match(joined, /app\.css/, 'the warning should name the files that will not load');
  assert.match(joined, /app\.js/);
  // And it must be visible to an agent reading the markdown, not only the JSON.
  assert.match(textOf(result), /app\.css/);
});

test('the warning explains the fix rather than just the symptom', async () => {
  const { result } = await callTool(h.baseUrl, API_TOKEN, 'site_publish', {
    slug: 'gated-advice', files: FILES, password: 'letmein-please',
  });
  const joined = structured(result).warnings.join(' ');
  assert.match(joined, /single file|inline/i, 'should tell the agent to inline its assets');
});

test('public multi-file sites are not warned about', async () => {
  const { result } = await callTool(h.baseUrl, API_TOKEN, 'site_publish', {
    slug: 'open-multi', files: FILES, visibility: 'public', confirm_public: true,
  });
  assert.deepEqual(structured(result).warnings ?? [], []);
  assert.ok(!textOf(result).includes('app.css'));
});

test('a gated single-file site is not warned about', async () => {
  const { result } = await callTool(h.baseUrl, API_TOKEN, 'site_publish', {
    slug: 'gated-single', html: '<style>body{color:red}</style><p>fine</p>', password: 'letmein-please',
  });
  assert.deepEqual(structured(result).warnings ?? [], []);
});

test('extra HTML pages do not count as subresources', async () => {
  // Navigations carry the cookie, so linked pages work; only subresources break.
  const { result } = await callTool(h.baseUrl, API_TOKEN, 'site_publish', {
    slug: 'gated-pages',
    files: [
      { path: 'index.html', content: '<a href="two.html">two</a>' },
      { path: 'two.html', content: '<p>two</p>' },
    ],
    password: 'letmein-please',
  });
  assert.deepEqual(structured(result).warnings ?? [], []);
});

test('adding a subresource to a locked site warns on update too', async () => {
  await callTool(h.baseUrl, API_TOKEN, 'site_publish', {
    slug: 'gated-grow', html: '<p>self contained</p>', password: 'letmein-please',
  });
  const { result } = await callTool(h.baseUrl, API_TOKEN, 'site_update_files', {
    slug: 'gated-grow', upsert: [{ path: 'late.css', content: 'body{}' }],
  });
  assert.match((structured(result).warnings ?? []).join(' '), /late\.css/);
});

test('locking an existing multi-file site warns at that moment too', async () => {
  await callTool(h.baseUrl, API_TOKEN, 'site_publish', { slug: 'later-locked', files: FILES });
  const { result } = await callTool(h.baseUrl, API_TOKEN, 'site_set_access', {
    slug: 'later-locked', visibility: 'password', password: 'letmein-please',
  });
  const warnings = structured(result).warnings;
  assert.ok(Array.isArray(warnings) && warnings.length > 0, 'set_access must warn as well');
  assert.match(warnings.join(' '), /app\.css/);
});
