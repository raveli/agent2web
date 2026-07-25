// Copies non-TypeScript runtime assets (SQL schema) next to the compiled output.
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, 'build', 'src');

await mkdir(target, { recursive: true });
await cp(join(root, 'src', 'schema.sql'), join(target, 'schema.sql'));
