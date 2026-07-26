import { Miniflare } from 'miniflare';
import { WebCryptoProvider } from '/Users/raveli/code/agent2web/build/src/core/crypto.js';
import { migrate } from '/Users/raveli/code/agent2web/build/src/core/schema.js';
import { Sql } from '/Users/raveli/code/agent2web/build/src/d1.js';
import { SiteStore } from '/Users/raveli/code/agent2web/build/src/store.js';
import { loadConfig } from '/Users/raveli/code/agent2web/build/src/core/config.js';

const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch: () => new Response("ok") }',
  d1Databases: ['DB'],
  r2Buckets: ['BLOBS'],
});
await mf.ready;

const db = await mf.getD1Database('DB');
const blobs = await mf.getR2Bucket('BLOBS');
const crypto = new WebCryptoProvider();
const sql = new Sql(db);

const config = await loadConfig(
  {
    A2W_PUBLIC_URL: 'https://a2w.example.com',
    A2W_SECRET: 'x'.repeat(40),
    A2W_ADMIN_PASSWORD: 'a-long-enough-password',
    A2W_SITES_BASE_DOMAIN: 'sites.example.com',
    A2W_KEEP_VERSIONS: '2',
  },
  crypto,
);

const ok = [];
const bad = [];
const check = (label, pass, detail = '') => (pass ? ok : bad).push(`${label}${detail ? ' — ' + detail : ''}`);

console.log('migrating D1 →', await migrate(sql));
const store = new SiteStore(db, blobs, config, crypto);

// ---- publish -------------------------------------------------------------
const first = await store.publish({
  slug: 'demo',
  title: 'Demo site',
  note: 'v1',
  files: [
    { path: 'index.html', content: '<h1>v1</h1>' },
    { path: 'assets/app.css', content: 'h1{color:teal}' },
    { path: '404.html', content: '<p>missing</p>' },
    { path: 'img/dot.png', content: 'iVBORw0KGgo=', encoding: 'base64' },
  ],
});
check('publish creates site', first.created && first.site.slug === 'demo');
check('version counted', first.version.file_count === 4, `${first.version.file_count} files`);

// ---- resolveRequest ------------------------------------------------------
const root = await store.resolveRequest(first.site, '/');
check('/ → index.html', root?.path === 'index.html', root?.path);
const css = await store.resolveRequest(first.site, '/assets/app.css');
check('exact path', css?.path === 'assets/app.css' && css.contentType.startsWith('text/css'), css?.contentType);
check('missing → undefined', (await store.resolveRequest(first.site, '/nope')) === undefined);
check('traversal → undefined', (await store.resolveRequest(first.site, '/%2e%2e/etc/passwd')) === undefined);
const png = await store.resolveRequest(first.site, '/img/dot.png');
check('binary content type', png?.contentType === 'image/png', png?.contentType);
const custom404 = await store.notFoundPage(first.site);
check('404.html found', custom404?.path === '404.html');

// the object must actually be streamable from R2
const object = await store.openBlob(root.key);
check('R2 object readable', (await object.text()) === '<h1>v1</h1>');

// ---- incremental update --------------------------------------------------
const second = await store.updateFiles('demo', [{ path: 'index.html', content: '<h1>v2</h1>' }], ['404.html'], 'v2');
check('carried files over', second.version.file_count === 3, `${second.version.file_count} files`);
const afterUpdate = await store.resolveRequest(second.site, '/');
check('serves new content', (await (await store.openBlob(afterUpdate.key)).text()) === '<h1>v2</h1>');
const keptCss = await store.resolveRequest(second.site, '/assets/app.css');
check('untouched file kept', keptCss !== undefined);
check('removed file gone', (await store.notFoundPage(second.site)) === undefined);

// ---- read back -----------------------------------------------------------
const read = await store.readSiteFile('demo', 'assets/app.css');
check('readSiteFile', new TextDecoder().decode(read.data) === 'h1{color:teal}');
const truncated = await store.readSiteFile('demo', 'assets/app.css', undefined, 1024);
check('truncation flag off when small', truncated.truncated === false);

// ---- versions + rollback -------------------------------------------------
const versions = await store.listVersions(first.site.id);
check('two versions listed', versions.length === 2, `${versions.length}`);
const rolled = await store.rollback('demo', first.version.id);
check('rollback switches pointer', rolled.site.current_version_id === first.version.id);
const afterRollback = await store.resolveRequest(rolled.site, '/');
check('rollback changes content', (await (await store.openBlob(afterRollback.key)).text()) === '<h1>v1</h1>');

// ---- prune (keepVersions = 2) -------------------------------------------
await store.publish({ slug: 'demo', files: [{ path: 'index.html', content: '<h1>v3</h1>' }], note: 'v3' });
const pruned = await store.listVersions(first.site.id);
check('prune caps versions', pruned.length === 2, `${pruned.length} kept`);
const orphans = await blobs.list({ prefix: `sites/${first.site.id}/` });
const liveVersions = new Set(pruned.map(v => v.id));
const strayKeys = orphans.objects.map(o => o.key).filter(k => !liveVersions.has(k.split('/')[2]));
check('prune deletes R2 objects', strayKeys.length === 0, strayKeys.join(' '));

// ---- access --------------------------------------------------------------
const locked = await store.setAccess('demo', 'password', 'open-sesame');
check('password set', locked.visibility === 'password' && !!locked.password_hash);
check('password verifies', await crypto.verifyPassword('open-sesame', locked.password_hash));
const opened = await store.setAccess('demo', 'public');
check('public clears hash', opened.visibility === 'public' && opened.password_hash === null);
try {
  await store.setAccess('demo', 'password');
  check('password required first time', false);
} catch (e) {
  check('password required first time', /no password set/.test(e.message));
}

// ---- errors keep their wording (tests assert on these) ------------------
const expectError = async (label, fn, re) => {
  try { await fn(); check(label, false, 'no error thrown'); }
  catch (e) { check(label, re.test(e.message), e.message.slice(0, 70)); }
};
await expectError('no index.html', () => store.publish({ slug: 'x', files: [{ path: 'a.html', content: 'x' }] }), /index\.html/);
await expectError('traversal rejected', () => store.publish({ slug: 'y', files: [{ path: 'index.html', content: 'x' }, { path: '../esc.html', content: 'x' }] }), /\.\./);
await expectError('duplicate slug', () => store.publish({ slug: 'demo', html: undefined, files: [{ path: 'index.html', content: 'x' }], ifExists: 'fail' }), /already exists/);
await expectError('unknown slug', () => store.requireSite('ghost'), /Known slugs include/);
await expectError('bad version', () => store.rollback('demo', 'nope'), /Recent versions/);
await expectError('remove missing', () => store.updateFiles('demo', [], ['ghost.css']), /not in the current version/);
await expectError('oversize file', () => store.publish({ slug: 'big', files: [{ path: 'index.html', content: 'x'.repeat(6 * 1024 * 1024) }] }), /per-file limit/);
await expectError('bad hostname', () => store.setDomain('demo', 'not a host'), /valid hostname/);

// ---- domains -------------------------------------------------------------
const withDomain = await store.setDomain('demo', 'Reports.Example.COM');
check('domain normalised', withDomain.custom_domain === 'reports.example.com');
check('lookup by domain', (await store.getSiteByDomain('reports.example.com'))?.slug === 'demo');

// ---- delete removes every object ----------------------------------------
await store.deleteSite('demo');
check('site row gone', (await store.getSiteBySlug('demo')) === undefined);
const remaining = await blobs.list({ prefix: `sites/${first.site.id}/` });
check('all R2 objects gone', remaining.objects.length === 0, `${remaining.objects.length} left`);
check('version rows cascade', (await sql.all('SELECT * FROM versions')).length === 0);
check('file rows cascade', (await sql.all('SELECT * FROM files')).length === 0);

console.log('\n' + ok.map(l => '  ok   ' + l).join('\n'));
if (bad.length) console.log('\n' + bad.map(l => '  FAIL ' + l).join('\n'));
console.log(`\n${ok.length} passed, ${bad.length} failed`);
await mf.dispose();
process.exit(bad.length ? 1 : 0);
