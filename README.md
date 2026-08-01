# agent2web

**Somewhere for Claude to put the HTML it just wrote.**

AI tools produce self-contained pages all day — dashboards, reports, prototypes —
and then there is nowhere to put them. agent2web is a personal static host with an
MCP server attached: Claude calls one tool and hands you back a URL.

Runs on Cloudflare Workers, D1 and R2. No server, no volume, no certificates to
renew.

```
You:     turn that into a page I can send my team
Claude:  [ site_publish ]  →  https://a2w.example.com/s/q3-report/
```

Ask for a change, it republishes to the same URL and keeps the old version.

<p align="center">
  <img src="docs/images/admin-sites-light.png#gh-light-mode-only" alt="The agent2web admin UI listing four published sites with their access state, version count, size and last published date" width="820">
  <img src="docs/images/admin-sites-dark.png#gh-dark-mode-only" alt="The agent2web admin UI listing four published sites with their access state, version count, size and last published date" width="820">
</p>

## What you get

- **Eleven `site_*` MCP tools** over streamable HTTP — publish, update single
  files, read back, rename, roll back, delete
- **Private by default** — a new site is password protected and the password is
  generated for you; making one world-readable takes a deliberate confirmation
- **Every publish is a new version.** Roll back from the admin UI or a tool call
- **Only you can publish.** Built-in OAuth 2.1 server for Claude web, plus a
  bearer token for Claude Code and CI
- **Three URL shapes**: `/s/<slug>/` always, `<slug>.yourdomain.com` with a
  wildcard record, and a custom domain per site
- **An admin UI** for what a chat window is bad at: revoking a connection,
  deleting something, seeing what is live

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/raveli/agent2web)

The button clones the repo into your GitHub account, provisions the D1 database
and R2 bucket declared in `wrangler.jsonc`, and wires up Workers Builds so every
push redeploys. You will be asked for two secrets — generate them first:

```bash
npm install && npm run gen-secrets
```

That prints `A2W_SECRET`, an optional `A2W_API_TOKEN`, and a password hash. Save
the admin password it shows; it is stored nowhere else.

The form asks only for those secrets and a size limit. There is no URL to enter:
the Worker records the origin you reach it on the first time you sign in to
`/admin` or call `/mcp` with your token. Add `A2W_PUBLIC_URL` later, in Settings →
Variables, when you attach a custom domain — it is the OAuth issuer and the
audience of every token issued, so from then on it must match exactly.

**Full guide**, with the terminal route, costs and troubleshooting:
[docs/deploying.html](docs/deploying.html) — an HTML file, so download it or
[read it rendered](https://raveli.github.io/agent2web/deploying.html).

### Requires the Workers Paid plan ($5/mo)

Not for scale — for **CPU time**. Password hashing is PBKDF2 at 600,000
iterations, which measures ~130 ms. The Free plan caps a request at 10 ms of CPU,
which would force an iteration count roughly an order of magnitude below current
guidance. Paid allows 30 s, so the hash is 0.4% of the budget, and the included
30M CPU-ms covers ~230,000 sign-ins a month.

### Subdomain hosting needs your own domain

A fresh deploy lands on `<name>.<subdomain>.workers.dev`, where **wildcard
subdomains do not exist**. Path URLs (`/s/<slug>/`) work immediately. For
`https://<slug>.sites.example.com/` you need a domain on Cloudflare, a proxied
`*.sites.example.com` record, a Workers route for it, and
`A2W_SITES_BASE_DOMAIN` set to that domain.

## Connecting Claude

### Claude web / desktop (custom connector)

Settings → Connectors → **Add custom connector** → URL `https://your-worker/mcp`.

Claude registers itself, then sends you to this server's sign-in page. Enter the
admin password (plus a TOTP code if configured) and approve the connection. Claude
never sees the password; it gets an access token scoped to publishing, revocable
at `/admin/connections`.

### Claude Code

```bash
# OAuth (opens a browser to sign in):
claude mcp add --transport http agent2web https://your-worker/mcp

# Or the static token, no browser involved:
claude mcp add --transport http agent2web https://your-worker/mcp \
  --header "Authorization: Bearer $A2W_API_TOKEN"
```

## The tools

| Tool | What it does |
| --- | --- |
| `site_publish` | Publishes `html` (single page) or `files` (multi-file, needs `index.html`). Same slug again → new version, same URL. Password protected unless you pass `visibility:"public"` **and** `confirm_public:true`; supply a `password` or let one be generated and returned once. |
| `site_update_files` | Adds/replaces/removes individual files, carrying the rest over. For iterating on big sites. |
| `site_list` | Lists sites with URLs and access state. Paginated. |
| `site_get` | One site: URLs, access, versions, file list. |
| `site_read_file` | Reads a published file back so it can be edited. |
| `site_set_access` | `public` (needs `confirm_public:true`) / `password` (generates one if none is set) / `disabled`. |
| `site_rename` | Change slug and/or title. |
| `site_set_domain` | Attach a custom hostname, and print the DNS steps. |
| `site_list_versions` | Retained versions, newest first. |
| `site_rollback` | Point a site back at an earlier version. |
| `site_delete` | Deletes the site and every version. Requires `confirm_slug`. |

Every tool takes `response_format: "markdown" | "json"` and returns structured
content alongside the text.

Default limits: 200 files, 5 MB per file, 25 MB per site, 10 versions retained.

## Local development

Full walkthrough in [docs/local-testing.html](docs/local-testing.html)
([rendered](https://raveli.github.io/agent2web/local-testing.html)). In short:

```bash
npm install
npm test          # boots the real Worker in Miniflare with local D1 + R2
npm run dev       # wrangler dev on http://localhost:8787
```

`npm test` is the honest one: it bundles the Worker exactly as `wrangler` does for
deploy, runs it in Miniflare with local D1 and R2 bindings, and talks to it over
HTTP. There is no in-process shortcut, so a green suite means the deployed code
path works.

## Security notes

- **Publishing requires the owner credential.** OAuth tokens are minted only after
  the admin password (and TOTP, if set) is entered on this server's own sign-in
  page, with an explicit consent step. Dynamic client registration is open, as the
  MCP spec requires, but a registration is worthless without that approval, and
  redirect URIs are restricted to Claude's hosts and http loopback.
- **Tokens at rest**: access, refresh and session tokens are stored only as HMACs
  keyed with `A2W_SECRET`. Passwords use PBKDF2-SHA256 at 600k iterations, run as six chained rounds of 100k because a deployed Worker refuses any single derivation above that.
- **Refresh tokens rotate.** Presenting a spent one revokes the whole chain;
  replaying an authorization code revokes everything issued from it.
- **Credential throttling lives in D1**, not in memory. Each Worker isolate has
  its own heap, so an in-memory limiter would appear to work while stopping
  nothing.
- **Published pages are untrusted HTML.** Served from the Worker's own origin (the
  `/s/…` URLs) they get `Content-Security-Policy: sandbox`, giving them an opaque
  origin so they cannot touch the admin session or the MCP endpoint. Set
  `A2W_SITE_SANDBOX=never` if your pages need `localStorage` or same-origin
  `fetch` — and prefer giving sites their own domain in that case.
- **Site hostnames are isolated**: a request arriving on a site's subdomain or
  custom domain cannot reach `/admin`, `/mcp` or the OAuth endpoints at all.
- **Dot segments are resolved by the URL parser** before the app sees a path, and
  `%2e` counts as a dot, so `/s/a/../b/` is simply a request for `/s/b/`. Access
  control applies to whatever site the path resolves to, and a traversal cannot
  leave a site's version prefix; `test/traversal.test.ts` asserts both.

## Configuration

Set as **secrets** (Settings → Variables, or `wrangler secret put`):

| Secret | Meaning |
| --- | --- |
| `A2W_SECRET` | 32+ chars. Signs cookies, hashes tokens at rest. |
| `A2W_ADMIN_PASSWORD_HASH` | From `npm run gen-secrets`, as `pbkdf2c.100000.6.<salt>.<key>`. (`A2W_ADMIN_PASSWORD` works but warns; if both are set the hash wins.) |
| `A2W_API_TOKEN` | Optional static bearer token for MCP. 32+ chars. Unset disables it. |
| `A2W_ADMIN_TOTP_SECRET` | Optional base32 secret; when set, sign-in also needs a 6-digit code. |

Set as **vars** in `wrangler.jsonc`:

| Var | Default | Meaning |
| --- | --- | --- |
| `A2W_PUBLIC_URL` | learned on first request | The Worker's public origin. OAuth issuer and token audience. Leave unset on a fresh deploy; set it exactly (no path, no trailing slash) when you attach a custom domain. |
| `A2W_SITES_BASE_DOMAIN` | unset | Enables `<slug>.<domain>` hosting. Add it in Settings → Variables once you have a domain with a proxied wildcard record; impossible on workers.dev. |
| `A2W_SITES_PATH_PREFIX` | `/s` | Prefix for path-based hosting. |
| `A2W_SITE_SANDBOX` | `auto` | `auto` sandboxes only same-origin site content; `always` / `never` override. |
| `A2W_MAX_FILE_BYTES` | `5242880` | Per-file limit. |
| `A2W_MAX_SITE_BYTES` | `26214400` | Per-site limit. Workers allows a 100 MB body but only 128 MB of isolate memory, and content arrives base64-inflated. |
| `A2W_MAX_FILES` | `200` | Files per site. |
| `A2W_KEEP_VERSIONS` | `10` | Versions retained per site. |
| `A2W_SITE_COOKIE_TTL_HOURS` | `168` | How long a site password unlock lasts. |
| `A2W_ADMIN_SESSION_TTL_HOURS` | `12` | Admin session lifetime. |
| `A2W_EXTRA_REDIRECT_URIS` | unset | Extra exact OAuth redirect URIs, comma separated. |

Bad configuration fails at startup with the reason, rather than half-working.

## How it is put together

```
src/
  core/       runtime-agnostic: tools, views, config, crypto, schema, routing
  d1.ts       thin all/first/run/batch over D1
  store.ts    sites, versions and files on D1 + R2
  oauth.ts    the OAuth 2.1 authorization server
  http/       the Hono app: hosting, admin, oauth pages, /mcp
  worker.ts   entry point
```

Objects in R2 are keyed `sites/<site-id>/<version-id>/<path>`, so a bucket
listing is readable. Publishing writes every object first, then moves
`current_version_id` in a single D1 `batch()` — a reader never sees a
half-published site.

## Status

Working and tested, but young — first released July 2026, and not yet running
anywhere long enough to have been surprised by it. The suite boots the real
Worker in Miniflare with local D1 and R2 and drives it over HTTP, so a green run
exercises the code path that deploys rather than a stand-in.

Issues and pull requests welcome.

## License

MIT
