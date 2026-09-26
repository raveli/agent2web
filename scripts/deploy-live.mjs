// Deploys to your own Worker, using settings kept out of the repository.
//
// wrangler.jsonc is the Deploy-to-Cloudflare template: its Worker name is the
// default and its database id is a placeholder the button fills in on a copy.
// Deploying it as-is from a checkout targets a Worker that may not be yours, or
// creates an empty one. This script overlays deploy.local.json (git-ignored;
// see deploy.local.example.json) onto the template, deploys that, and deletes
// the merged file again.
//
// Usage: npm run deploy:live [-- <extra wrangler deploy flags>]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const LOCAL = 'deploy.local.json';
const MERGED = 'wrangler.live.json';

if (!existsSync(LOCAL)) {
  console.error(`${LOCAL} not found. Copy deploy.local.example.json to ${LOCAL} and fill it in.`);
  process.exit(1);
}
const local = JSON.parse(readFileSync(LOCAL, 'utf8'));
for (const key of ['name', 'd1_database_id']) {
  if (typeof local[key] !== 'string' || local[key] === '' || local[key].startsWith('<')) {
    console.error(`${LOCAL} needs "${key}". Find it with: npx wrangler deployments list / npx wrangler d1 list`);
    process.exit(1);
  }
}
for (const [key, value] of Object.entries(local.vars ?? {})) {
  if (String(value).startsWith('<')) {
    console.error(`${LOCAL}: vars.${key} is still the example placeholder. Set it or remove it.`);
    process.exit(1);
  }
}

const config = parseJsonc(readFileSync('wrangler.jsonc', 'utf8'));
delete config.$schema;
config.name = local.name;
config.d1_databases = config.d1_databases.map(db => ({ ...db, database_id: local.d1_database_id }));
// wrangler deploy replaces the Worker's plain-text variables with exactly these,
// so every var the deployment relies on has to be listed here. Secrets are not
// touched.
config.vars = { ...config.vars, ...(local.vars ?? {}) };

writeFileSync(MERGED, JSON.stringify(config, null, 2));
try {
  execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
  execFileSync('npx', ['wrangler', 'deploy', '--config', MERGED, ...process.argv.slice(2)], { stdio: 'inherit' });
} catch {
  process.exitCode = 1;
} finally {
  rmSync(MERGED, { force: true });
}

/** JSON with // and /* comments and trailing commas, as wrangler.jsonc is written. */
function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}
