import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { findMissingReferences, type CheckFile } from '../src/core/check.js';

// Backlog #71: which files a site's HTML and CSS point at that it does not have.

const html = (path: string, text: string): CheckFile => ({ path, contentType: 'text/html; charset=utf-8', text });
const css = (path: string, text: string): CheckFile => ({ path, contentType: 'text/css; charset=utf-8', text });
const other = (path: string): CheckFile => ({ path, contentType: 'application/octet-stream' });

test('a site whose references all exist has nothing missing', () => {
  const files = [
    html('index.html', '<link rel="stylesheet" href="styles.css"><script src="js/app.js"></script><img src=logo.png>'),
    css('styles.css', 'body{background:url("img/bg.png")}'),
    other('js/app.js'),
    other('logo.png'),
    other('img/bg.png'),
  ];
  assert.deepEqual(findMissingReferences(files), []);
});

test('each kind of reference is checked, and a missing target is reported with where it came from', () => {
  const files = [
    html(
      'index.html',
      `<link href='a.css' rel=stylesheet><script src="b.js"></script><img src=c.png>` +
        `<source src="d.mp4"><iframe src="e.html"></iframe><a href="f.html">f</a>`,
    ),
    css('present.css', `@font-face{src:url(fonts/g.woff2)} .x{background:url('h.png')}`),
  ];
  assert.deepEqual(findMissingReferences(files), [
    { file: 'index.html', reference: 'a.css', resolved: 'a.css' },
    { file: 'index.html', reference: 'b.js', resolved: 'b.js' },
    { file: 'index.html', reference: 'c.png', resolved: 'c.png' },
    { file: 'index.html', reference: 'd.mp4', resolved: 'd.mp4' },
    { file: 'index.html', reference: 'e.html', resolved: 'e.html' },
    { file: 'index.html', reference: 'f.html', resolved: 'f.html' },
    { file: 'present.css', reference: 'fonts/g.woff2', resolved: 'fonts/g.woff2' },
    { file: 'present.css', reference: 'h.png', resolved: 'h.png' },
  ]);
});

test('references resolve relative to the file that makes them, as a browser would', () => {
  const files = [
    html('docs/guide/page.html', '<link href="../../style.css"><img src="./img/x.png?v=2#top"><a href="/root.html">r</a>'),
    css('assets/css/site.css', '.a{background:url(../img/y.png)}'),
    other('style.css'),
    other('docs/guide/img/x.png'),
    other('root.html'),
    other('assets/img/y.png'),
  ];
  assert.deepEqual(findMissingReferences(files), []);

  // Above the site root, a browser clamps to the root; so do we.
  assert.deepEqual(findMissingReferences([html('a/b.html', '<img src="../../../z.png">')]), [
    { file: 'a/b.html', reference: '../../../z.png', resolved: 'z.png' },
  ]);
});

test('links to directories and extensionless pages count as present when the server would serve them', () => {
  const files = [
    html('index.html', '<a href="about/">a</a><a href="team">t</a><a href="blog/post">p</a>'),
    other('about/index.html'),
    other('team.html'),
    other('blog/post/index.html'),
  ];
  assert.deepEqual(findMissingReferences(files), []);
});

test('external links, anchors, data and other schemes are not the site\'s to have', () => {
  const files = [
    html(
      'index.html',
      '<a href="#top">t</a><a href="https://example.com/x.css">e</a><script src="//cdn.example.com/a.js"></script>' +
        '<img src="data:image/png;base64,AAAA"><a href="mailto:a@b.c">m</a><a href="tel:+358">p</a>' +
        '<a href="javascript:void 0">j</a><a href="">empty</a><img src="${template}">',
    ),
    css('s.css', '.a{background:url(data:image/svg+xml,%3Csvg%3E)} .b{background:url(https://example.com/i.png)}'),
  ];
  assert.deepEqual(findMissingReferences(files), []);
});

test('only HTML and CSS are scanned; a JavaScript file mentioning a path is not checked', () => {
  const files = [
    html('index.html', '<p>no references</p>'),
    { path: 'app.js', contentType: 'text/javascript; charset=utf-8', text: 'fetch("data.json")' },
  ];
  assert.deepEqual(findMissingReferences(files), []);
});
