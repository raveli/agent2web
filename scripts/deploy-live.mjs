// Deploys to your own Worker, using settings kept out of the repository.
//
// wrangler.jsonc is the Deploy-to-Cloudflare template: its Worker name is the
// default and its database id is a placeholder the button fills in on a copy.
// Deploying it as-is from a checkout targets a Worker that may not be yours, or
// creates an empty one. This script overlays your own settings onto the
// template, deploys that, and deletes the merged file again.
//
// Settings come from environment variables, which is how Workers Builds passes
// them (Settings -> Build -> Variables), or from a git-ignored deploy.local.json
// (see deploy.local.example.json) for deploys from your own machine. An
// environment variable wins over the file.
//
//   A2W_DEPLOY_NAME      the Worker's name, as shown in the dashboard
//   A2W_DEPLOY_D1_ID     the D1 database id (npx wrangler d1 list)
//   A2W_SITES_BASE_DOMAIN, A2W_PUBLIC_URL, ...   any plain-text setting below,
//                        deployed as a Worker variable
//
// Usage: npm run deploy:live [-- <extra wrangler deploy flags>]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const LOCAL = 'deploy.local.json';
const MERGED = 'wrangler.live.json';

// Plain-text settings only. Secrets (A2W_SECRET, A2W_API_TOKEN, the admin
// password and TOTP secret) are set on the Worker and never pass through here,
// so a build variable of that name cannot turn into a readable Worker variable.
const PLAIN_VARS = [
  'A2W_PUBLIC_URL',
  'A2W_SITES_BASE_DOMAIN',
  'A2W_SITES_PATH_PREFIX',
  'A2W_SITE_SANDBOX',
  'A2W_MAX_FILE_BYTES',
  'A2W_MAX_SITE_BYTES',
  'A2W_MAX_FILES',
  'A2W_KEEP_VERSIONS',
  'A2W_SITE_COOKIE_TTL_HOURS',
  'A2W_ADMIN_SESSION_TTL_HOURS',
  'A2W_EXTRA_REDIRECT_URIS',
];

const file = existsSync(LOCAL) ? JSON.parse(readFileSync(LOCAL, 'utf8')) : {};
const env = process.env;
const settings = {
  name: env.A2W_DEPLOY_NAME || file.name,
  d1Id: env.A2W_DEPLOY_D1_ID || file.d1_database_id,
  vars: { ...(file.vars ?? {}) },
};
for (const key of PLAIN_VARS) if (env[key]) settings.vars[key] = env[key];

for (const [label, value, hint] of [
  ['A2W_DEPLOY_NAME', settings.name, 'the Worker name shown in the dashboard'],
  ['A2W_DEPLOY_D1_ID', settings.d1Id, 'from: npx wrangler d1 list'],
]) {
  if (!value || value.startsWith('<')) {
    fail(`Missing ${label} (${hint}). Set it as an environment variable, or in ${LOCAL} — see deploy.local.example.json.`);
  }
}
for (const [key, value] of Object.entries(settings.vars)) {
  if (!PLAIN_VARS.includes(key)) fail(`vars.${key} is not a plain-text agent2web setting. Secrets belong on the Worker.`);
  if (String(value).startsWith('<')) fail(`vars.${key} is still the example placeholder. Set it or remove it.`);
}

const config = parseJsonc(readFileSync('wrangler.jsonc', 'utf8'));
delete config.$schema;
config.name = settings.name;
config.d1_databases = config.d1_databases.map(db => ({ ...db, database_id: settings.d1Id }));
// wrangler deploy replaces the Worker's plain-text variables with exactly these,
// so every var the deployment relies on has to be listed. Secrets are untouched.
config.vars = { ...config.vars, ...settings.vars };

console.log(`Deploying ${settings.name} with vars: ${Object.keys(config.vars).join(', ')}`);
writeFileSync(MERGED, JSON.stringify(config, null, 2));
try {
  execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
  execFileSync('npx', ['wrangler', 'deploy', '--config', MERGED, ...process.argv.slice(2)], { stdio: 'inherit' });
} catch {
  process.exitCode = 1;
} finally {
  rmSync(MERGED, { force: true });
}

function fail(message) {
  console.error(message);
  process.exit(1);
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
