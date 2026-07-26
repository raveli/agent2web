import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { blobKey, candidatesFor, decodeRequestPath, normalizeSitePath } from '../src/core/paths.js';
import { isValidSlug, slugify } from '../src/util/ids.js';

test('normalizeSitePath accepts ordinary relative paths', () => {
  assert.equal(normalizeSitePath('index.html'), 'index.html');
  assert.equal(normalizeSitePath('/index.html'), 'index.html');
  assert.equal(normalizeSitePath('assets/app.css'), 'assets/app.css');
  assert.equal(normalizeSitePath('  deep/nested/file.js  '), 'deep/nested/file.js');
  assert.equal(normalizeSitePath('.well-known/thing.txt'), '.well-known/thing.txt');
});

test('normalizeSitePath rejects traversal and other unsafe input', () => {
  const bad = [
    '../secret',
    'a/../../b',
    'a/./b',
    'a//b',
    '..',
    '/',
    '',
    '   ',
    'C:/windows/system32',
    'dir\\file.html',
    'file:name.html',
    'nul\u0000.html',
    'bell\u0007.html',
    'x'.repeat(1025),
    `${'y'.repeat(201)}.html`,
  ];
  for (const input of bad) {
    assert.throws(() => normalizeSitePath(input), /path/i, `expected rejection for ${JSON.stringify(input)}`);
  }
});

test('blob keys are confined to their site and version', () => {
  assert.equal(blobKey('site1', 'ver1', 'index.html'), 'sites/site1/ver1/index.html');
  assert.equal(blobKey('site1', 'ver1', '/assets/app.css'), 'sites/site1/ver1/assets/app.css');
  // A key can only be built through the same validation writes go through.
  assert.throws(() => blobKey('site1', 'ver1', '../../other/index.html'), /\.\./);
  assert.throws(() => blobKey('site1', 'ver1', '/'), /name a file/);
});

test('candidate resolution prefers exact paths, then index, then .html', () => {
  assert.deepEqual(candidatesFor('/'), ['index.html']);
  assert.deepEqual(candidatesFor('/about'), ['about', 'about/index.html', 'about.html']);
  assert.deepEqual(candidatesFor('/docs/'), ['docs/index.html']);
  // Nothing that fails validation can become a candidate.
  assert.deepEqual(candidatesFor('/%2e%2e/etc'), []);
  assert.deepEqual(candidatesFor('/a\\b'), []);
});

test('decodeRequestPath blocks encoded traversal', () => {
  assert.equal(decodeRequestPath('/index.html'), 'index.html');
  assert.equal(decodeRequestPath('/a%20b.html'), 'a b.html');
  assert.equal(decodeRequestPath('/%2e%2e/etc/passwd'), undefined);
  assert.equal(decodeRequestPath('/..%2fetc'), undefined);
  assert.equal(decodeRequestPath('/%ZZ'), undefined);
});

test('slug validation matches the documented rules', () => {
  for (const slug of ['a', 'my-report', 'q3-2026-numbers']) assert.ok(isValidSlug(slug), slug);
  for (const slug of ['', '-lead', 'trail-', 'Upper', 'has_underscore', 'admin', 'mcp', 'a--b', 'a'.repeat(64)]) {
    assert.ok(!isValidSlug(slug), slug);
  }
});

test('slugify derives usable slugs from titles', () => {
  assert.equal(slugify('Q3 Revenue Report!'), 'q3-revenue-report');
  assert.equal(slugify('Ärsredovisning 2026'), 'arsredovisning-2026');
  assert.equal(slugify('***'), '');
});
