import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { join } from 'node:path';
import { decodeRequestPath, normalizeSitePath, safeJoin } from '../src/storage.js';
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

test('safeJoin refuses to leave the root', () => {
  const root = join('/tmp', 'a2w-root');
  assert.equal(safeJoin(root, 'index.html'), join(root, 'index.html'));
  assert.throws(() => safeJoin(root, '../outside.html'), /escapes/);
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
