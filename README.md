# agent2web

Self-hosted hosting for static HTML, with an MCP server so AI tools can publish
to it directly. Claude builds a page, calls one tool, and you get a URL.

One container, one volume, no external services. Runs anywhere Docker runs;
the Kubernetes manifests target k3s.

- **MCP endpoint** at `/mcp` (streamable HTTP) with eleven `site_*` tools
- **Static hosting** at `https://your-host/s/<slug>/`, optionally also at
  `https://<slug>.sites.example.com/` and at a per-site custom domain
- **Password protection** per site, plus public/disabled
- **Versioning**: every publish is a new immutable version; roll back at will
- **Owner-only publishing**: built-in OAuth 2.1 server (what Claude web uses) and
  a static bearer token (what Claude Code and CI use)
- **Admin UI** for the things a chat window is bad at: revoking access, deleting

## Quick start (Docker)

```bash
git clone https://github.com/raveli/agent2web && cd agent2web
npm install
npm run gen-secrets           # prints A2W_SECRET, A2W_API_TOKEN, a password hash

cp .env.example .env          # paste the generated values in, set A2W_PUBLIC_URL
docker compose up -d --build

curl -fsS http://localhost:8080/healthz
```

Publish something without any client at all:

```bash
curl -s http://localhost:8080/mcp \
  -H "authorization: Bearer $A2W_API_TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"site_publish",
        "arguments":{"slug":"hello","html":"<h1>Hello from agent2web</h1>"}}}'

open http://localhost:8080/s/hello/
```

(The MCP spec requires clients to accept both `application/json` and
`text/event-stream`; this server always answers with JSON, but it will return 406
if the `accept` header omits either.)

For Kubernetes, see [deploy/README.md](deploy/README.md).

## Connecting Claude

### Claude web / desktop (custom connector)

Settings → Connectors → **Add custom connector** → URL `https://your-host/mcp`.

Claude registers itself, then sends you to this server's sign-in page. Enter the
admin password (plus a TOTP code if you configured one) and approve the
connection. Claude never sees the password; it gets an access token scoped to
publishing, which you can revoke at `/admin/connections`.

This requires HTTPS with a certificate a public client will trust, and
`A2W_PUBLIC_URL` must exactly match the URL you enter.

### Claude Code

```bash
# OAuth (opens a browser to sign in):
claude mcp add --transport http agent2web https://your-host/mcp

# Or the static token, no browser involved:
claude mcp add --transport http agent2web https://your-host/mcp \
  --header "Authorization: Bearer $A2W_API_TOKEN"
```

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Point it at `http://localhost:8080/mcp`. Both auth methods work; the OAuth flow
uses a loopback callback, which the redirect policy allows on any port.

## The tools

| Tool | What it does |
| --- | --- |
| `site_publish` | Publishes `html` (single page) or `files` (multi-file, needs `index.html`). Same slug again → new version, same URL. Optional `password`. |
| `site_update_files` | Adds/replaces/removes individual files, carrying the rest over. For iterating on big sites. |
| `site_list` | Lists sites with URLs and access state. Paginated. |
| `site_get` | One site: URLs, access, versions, file list. |
| `site_read_file` | Reads a published file back so it can be edited. |
| `site_set_access` | `public` / `password` / `disabled`. |
| `site_rename` | Change slug and/or title. |
| `site_set_domain` | Attach a custom hostname, and print the DNS/ingress steps. |
| `site_list_versions` | Retained versions, newest first. |
| `site_rollback` | Point a site back at an earlier version. |
| `site_delete` | Deletes the site and every version. Requires `confirm_slug`. |

Every tool takes `response_format: "markdown" | "json"` and returns structured
content alongside the text.

Default limits: 200 files, 5 MB per file, 50 MB per site, 10 versions retained.
All configurable.

## Password-protected sites

```
site_publish(slug: "board-deck", html: "…", password: "…")
site_set_access(slug: "board-deck", visibility: "password", password: "…")
```

Visitors get a small form; unlocking sets a signed, HttpOnly cookie scoped to
that site. `curl -u :the-password https://host/s/board-deck/` works too, for
scripts. Failed attempts are throttled per IP and site. Changing the password
invalidates every cookie already issued.

`visibility: "disabled"` makes a site return 404 without deleting anything.

## URLs

Three ways to reach a site, all live at once:

| Form | Needs | Notes |
| --- | --- | --- |
| `https://app-host/s/<slug>/` | nothing | Always available. Root-absolute asset paths (`/style.css`) don't resolve — use relative paths. |
| `https://<slug>.sites.example.com/` | `A2W_SITES_BASE_DOMAIN`, wildcard DNS + cert | Own origin per site, root-absolute paths work. |
| `https://custom.example.com/` | `site_set_domain` + your DNS/ingress | Same, for one specific site. |

Custom domains are resolved from the `Host` header the moment you set them.
agent2web does not provision DNS or TLS — the tool returns the two steps you need
to take, and `deploy/README.md` has the ingress snippets.

## Security notes

- **Publishing requires the owner credential.** OAuth tokens are minted only
  after the admin password (and TOTP, if set) is entered on this server's own
  sign-in page, with an explicit consent step. Dynamic client registration is
  open, as the MCP spec requires, but a registration is worthless without that
  approval, and redirect URIs are restricted to Claude's hosts and http loopback.
- **Tokens at rest**: access, refresh and session tokens are stored only as
  HMACs keyed with `A2W_SECRET`. Passwords use scrypt.
- **Refresh tokens rotate.** Presenting a spent one revokes the whole chain;
  replaying an authorization code revokes everything issued from it.
- **Published pages are untrusted HTML.** Served from the app's own origin (the
  `/s/…` URLs) they get `Content-Security-Policy: sandbox`, which puts them in an
  opaque origin so they cannot touch the admin session or call the MCP endpoint.
  Set `A2W_SITE_SANDBOX=never` if your pages need `localStorage` or same-origin
  `fetch` — and prefer giving sites their own domain in that case.
- **Site hostnames are isolated**: a request arriving on a site's subdomain or
  custom domain cannot reach `/admin`, `/mcp` or the OAuth endpoints at all.
- Uploaded paths are validated in one place and re-checked against the site
  directory after resolution; nothing is served outside the current version.

## Configuration

Required:

| Variable | Meaning |
| --- | --- |
| `A2W_PUBLIC_URL` | Public origin of the app, e.g. `https://a2w.example.com`. OAuth issuer and token audience. No path. |
| `A2W_SECRET` | 32+ chars. Signs cookies, hashes tokens at rest. |
| `A2W_ADMIN_PASSWORD_HASH` | From `npm run gen-secrets`. (`A2W_ADMIN_PASSWORD` works but warns.) |

Optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `A2W_API_TOKEN` | unset | Static bearer token for MCP. 32+ chars. Unset disables it. |
| `A2W_ADMIN_TOTP_SECRET` | unset | Base32 secret; when set, sign-in also needs a 6-digit code. |
| `A2W_SITES_BASE_DOMAIN` | unset | Enables `<slug>.<domain>` hosting. |
| `A2W_SITES_PATH_PREFIX` | `/s` | Prefix for path-based hosting. |
| `A2W_SITE_SANDBOX` | `auto` | `auto` sandboxes only same-origin site content; `always` / `never` override. |
| `A2W_DATA_DIR` | `/data` | Database and site files. |
| `A2W_PORT` / `A2W_BIND` | `8080` / `0.0.0.0` | Listener. |
| `A2W_TRUST_PROXY` | `true` | Trust one hop of `X-Forwarded-*`. |
| `A2W_MAX_FILE_BYTES` | `5242880` | Per-file limit. |
| `A2W_MAX_SITE_BYTES` | `52428800` | Per-site limit. |
| `A2W_MAX_FILES` | `200` | Files per site. |
| `A2W_KEEP_VERSIONS` | `10` | Versions retained per site. |
| `A2W_SITE_COOKIE_TTL_HOURS` | `168` | How long a site password unlock lasts. |
| `A2W_ADMIN_SESSION_TTL_HOURS` | `12` | Admin session lifetime. |
| `A2W_EXTRA_REDIRECT_URIS` | unset | Extra exact OAuth redirect URIs, comma separated. |

Bad configuration fails at startup with the reason, rather than half-working.

## Development

```bash
npm install
npm run typecheck
npm test              # builds, then runs the suite with node --test
npm run dev           # build, then run with --watch on the compiled output
```

Layout: `src/mcp` (server + tools), `src/hosting` (resolve → gate → serve),
`src/auth` (OAuth provider, sessions, passwords, TOTP), `src/admin` (UI),
`src/storage.ts` (versions and path safety), `src/db.ts` (SQLite + migrations).

Storage on disk:

```
/data/agent2web.db
/data/sites/<site-id>/<version-id>/index.html
```

Publishing writes a whole new version directory and only then flips the site's
pointer, so a reader never sees a half-written site.

## License

MIT
