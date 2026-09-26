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

// Review findings: text that is not markup must not be read as references.
test('markup inside code samples, comments, scripts and attribute text is not a reference', () => {
  const files = [
    html(
      'index.html',
      '<pre><code>&lt;link href="theme.css"&gt;</code></pre>' +
        '<p>&lt;a href=&quot;x.html&quot;&gt;</p>' +
        '<!-- <script src="old.js"></script> -->' +
        `<script>const a = '<a href="' + url + '">'; document.write('<img src="later.png">')</script>` +
        '<p title="see href=y.html">t</p>' +
        '<template><img src="tpl.png"></template><textarea><img src="ta.png"></textarea>',
    ),
  ];
  assert.deepEqual(findMissingReferences(files), []);
});

test('a script tag\'s own src is still checked', () => {
  assert.deepEqual(findMissingReferences([html('index.html', '<script src="app.js">const x = 1</script>')]), [
    { file: 'index.html', reference: 'app.js', resolved: 'app.js' },
  ]);
});

test('inline CSS in style blocks and style attributes is checked, and @import too', () => {
  const files = [
    html(
      'index.html',
      '<style>@import "base.css"; @import url(theme.css); body{background:url(bg.png)}</style>' +
        '<div style="background-image:url(\'hero.jpg\')"></div>',
    ),
    css('s.css', '@import "more.css";'),
  ];
  assert.deepEqual(findMissingReferences(files), [
    { file: 'index.html', reference: 'base.css', resolved: 'base.css' },
    { file: 'index.html', reference: 'theme.css', resolved: 'theme.css' },
    { file: 'index.html', reference: 'bg.png', resolved: 'bg.png' },
    { file: 'index.html', reference: 'hero.jpg', resolved: 'hero.jpg' },
    { file: 's.css', reference: 'more.css', resolved: 'more.css' },
  ]);
});

test('CSS comments are not references', () => {
  assert.deepEqual(findMissingReferences([css('s.css', '/* url(old.png) @import "gone.css"; */ a{}')]), []);
});

test('srcset and poster are checked; a base element is not itself a missing file', () => {
  const files = [
    html(
      'index.html',
      '<base href="/sub/"><img srcset="a.png 1x, img/b.png 2x" src="a.png"><video poster="p.jpg"></video>',
    ),
    other('a.png'),
  ];
  assert.deepEqual(findMissingReferences(files), [
    { file: 'index.html', reference: 'img/b.png', resolved: 'img/b.png' },
    { file: 'index.html', reference: 'p.jpg', resolved: 'p.jpg' },
  ]);
});

test('entities in attribute values are decoded, and resolved paths are shown decoded', () => {
  const files = [
    html('index.html', '<a href="page.html?a=1&amp;b=2">x</a><img src="my%20pic.png"><img src="äiti.jpg">'),
    other('page.html'),
  ];
  assert.deepEqual(findMissingReferences(files), [
    { file: 'index.html', reference: 'my%20pic.png', resolved: 'my pic.png' },
    { file: 'index.html', reference: 'äiti.jpg', resolved: 'äiti.jpg' },
  ]);
});

test('uppercase tags and attributes are read like lowercase ones', () => {
  assert.deepEqual(findMissingReferences([html('index.html', '<IMG SRC="Up.PNG">')]), [
    { file: 'index.html', reference: 'Up.PNG', resolved: 'Up.PNG' },
  ]);
});

// Second review: tags are read with quotes taken into account, in one pass.
test('a ">" inside a quoted attribute value does not end the tag', () => {
  const files = [
    html(
      'index.html',
      '<img v-if="items.length > 0" src="m1.png"><img alt="a > b" src="m2.png"><a title=">" href="m3.html">x</a>' +
        '<button @click="n > 1 && go()" style="background:url(m4.png)">b</button>',
    ),
  ];
  assert.deepEqual(
    findMissingReferences(files).map(m => m.resolved),
    ['m1.png', 'm2.png', 'm3.html', 'm4.png'],
  );
});

test('markup inside an attribute value is not a reference', () => {
  const files = [html('index.html', '<iframe srcdoc="<img src=&quot;sd.png&quot;>"></iframe><div data-x="<img src=fp.png>"></div>')];
  assert.deepEqual(findMissingReferences(files), []);
});

test('comment and raw-text markers inside script strings do not hide what follows', () => {
  const files = [
    html('index.html', '<script>var s="<!--";</script><img src="real1.png"><script>var t="-->";</script>'),
    html('b.html', '<script>var s="<textarea>";</script><img src="real2.png">'),
    css('s.css', '.a{content:"/*"} .b{background:url(real3.png)} .c{content:"*/"}'),
  ];
  assert.deepEqual(findMissingReferences(files).map(m => m.resolved), ['real1.png', 'real2.png', 'real3.png']);
});

test('srcset follows the HTML rules: data URIs and commas inside a URL stay whole', () => {
  const files = [
    html('index.html', '<img srcset="data:image/png;base64,AAAA 1x, img/a,b.png 2x, c.png">'),
    other('img/a,b.png'),
  ];
  assert.deepEqual(findMissingReferences(files).map(m => m.resolved), ['c.png']);
});

test('unclosed style and script behave as a browser reads them', () => {
  assert.deepEqual(findMissingReferences([html('a.html', '<style>body{background:url(s.png)}')]).map(m => m.resolved), ['s.png']);
  assert.deepEqual(findMissingReferences([html('b.html', '<script>document.write("<img src=x.png>")')]), []);
  // <style/> opens a style element; what follows is CSS text, not a tag.
  assert.deepEqual(findMissingReferences([html('c.html', '<style/><img src="after.png">')]), []);
});

test('unterminated and adversarial input is scanned in linear time', () => {
  const cases = [
    'a<b '.repeat(250_000),
    '<a '.repeat(350_000),
    '<script'.repeat(150_000),
    '<!--'.repeat(250_000),
    '<img src="x.png" alt="'.repeat(40_000),
  ];
  for (const text of cases) {
    const started = performance.now();
    findMissingReferences([html('index.html', text)]);
    const ms = performance.now() - started;
    assert.ok(ms < 1000, `${text.slice(0, 12)}… (${text.length} chars) took ${Math.round(ms)} ms`);
  }
  const started = performance.now();
  findMissingReferences([css('s.css', 'url('.repeat(250_000))]);
  assert.ok(performance.now() - started < 1000, 'CSS url( without a closing paren');
});

// Final review: many references in one inline block must not overflow the stack.
test('a style block, style attribute or srcset with hundreds of thousands of references does not crash', () => {
  const many = 'a{background:url(x.png)}'.repeat(200_000);
  const files = [
    html('a.html', `<style>${many}</style>`),
    html('b.html', `<div style="${'background:url(y.png);'.repeat(200_000)}"></div>`),
    html('c.html', `<img srcset="${'z.png 1x, '.repeat(200_000)}">`),
  ];
  const missing = findMissingReferences(files);
  assert.equal(missing.length, 600_000);
});

test('empty comments <!--> and <!---> end where browsers end them', () => {
  assert.deepEqual(
    findMissingReferences([html('index.html', '<!--><img src="e1.png"><!---><img src="e2.png">')]).map(m => m.resolved),
    ['e1.png', 'e2.png'],
  );
});
