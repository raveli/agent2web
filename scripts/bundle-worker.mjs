// Bundles the Worker into a single module.
//
// Wrangler does this itself on deploy, but Miniflare needs one file it can load
// without resolving bare imports, so the test harness uses this output. Building
// it the same way for both keeps what tests exercise identical to what ships.
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const result = await build({
  entryPoints: [join(root, 'build/src/worker.js')],
  outfile: join(root, 'build/worker.bundle.js'),
  bundle: true,
  format: 'esm',
  target: 'esnext',
  platform: 'neutral',
  // Prefer the workerd/browser entry of any package that offers one.
  conditions: ['workerd', 'worker', 'browser', 'import', 'default'],
  mainFields: ['module', 'main'],
  // node: specifiers stay external; the Worker runs with nodejs_compat.
  external: ['node:*', 'cloudflare:*'],
  logLevel: 'warning',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs)[0].bytes;
console.log(`worker bundle: ${(bytes / 1024).toFixed(0)} KB`);

// Anything reaching for a node builtin is worth knowing about explicitly, since
// only part of node is available under nodejs_compat.
const nodeImports = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  for (const imp of result.metafile.inputs[input].imports ?? []) {
    if (imp.path.startsWith('node:')) nodeImports.add(imp.path);
  }
}
if (nodeImports.size) console.log('node builtins used:', [...nodeImports].join(', '));
