import type { Config } from '../config.js';
import type { OAuthClientRow, SiteRow, VersionRow } from '../db.js';
import { card, page } from '../ui/layout.js';
import { esc, formatBytes, formatDate } from '../util/html.js';
import { siteUrls } from '../urls.js';

const NAV = [
  { href: '/admin', label: 'Sites' },
  { href: '/admin/connections', label: 'Connections' },
];

export function adminLoginPage(config: Config, error?: string, next = '/admin'): string {
  const totpField = config.adminTotpSecret
    ? `<label for="totp">Authenticator code</label>
<input id="totp" name="totp" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required>`
    : '';
  return card(
    'agent2web admin',
    `<h1>agent2web</h1>
<p>Sign in with the admin password.</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<form method="post" action="/admin/login">
  <input type="hidden" name="next" value="${esc(next)}">
  <label for="password">Admin password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
  ${totpField}
  <button type="submit">Sign in</button>
</form>`,
  );
}

export type SiteListEntry = {
  site: SiteRow;
  versions: VersionRow[];
  bytes: number;
};

export function sitesPage(
  config: Config,
  entries: SiteListEntry[],
  csrf: string,
  flash: { ok?: string; err?: string },
): string {
  const rows = entries.map(entry => siteRow(config, entry, csrf)).join('');
  const body = `${flashHtml(flash)}
<h1>Published sites</h1>
<p>${entries.length} site${entries.length === 1 ? '' : 's'} · publish new ones through the MCP connector.</p>
${
  entries.length
    ? `<div class="scroll"><table>
<thead><tr><th>Site</th><th>Access</th><th>Size</th><th>Views</th><th>Updated</th><th>Actions</th></tr></thead>
<tbody>${rows}</tbody></table></div>`
    : '<div class="card-block">Nothing published yet. Connect a client and call <code>site_publish</code>.</div>'
}
${logoutForm(csrf)}`;
  return page('agent2web — sites', body, NAV);
}

function siteRow(config: Config, entry: SiteListEntry, csrf: string): string {
  const { site, versions, bytes } = entry;
  const urls = siteUrls(config, site);
  const versionOptions = versions
    .map(
      v =>
        `<option value="${esc(v.id)}"${v.id === site.current_version_id ? ' selected' : ''}>${esc(
          formatDate(v.created_at),
        )}${v.id === site.current_version_id ? ' (current)' : ''}</option>`,
    )
    .join('');
  const domain = site.custom_domain ?? '';
  return `<tr>
  <td><a href="${esc(urls.primary)}" rel="noreferrer">${esc(site.slug)}</a><br>
    <span class="pill">${esc(site.title || 'untitled')}</span>
    ${site.custom_domain ? `<br><span class="mono">${esc(site.custom_domain)}</span>` : ''}</td>
  <td>${esc(site.visibility)}</td>
  <td>${esc(formatBytes(bytes))}<br><span class="pill">${versions.length} version${
    versions.length === 1 ? '' : 's'
  }</span></td>
  <td>${site.view_count}</td>
  <td>${esc(formatDate(site.updated_at))}</td>
  <td>
    <div class="actions">
      <form method="post" action="/admin/sites/${esc(site.slug)}/access">
        ${hidden(csrf)}
        <select name="visibility">
          ${['public', 'password', 'disabled']
            .map(v => `<option value="${v}"${site.visibility === v ? ' selected' : ''}>${v}</option>`)
            .join('')}
        </select>
        <input type="password" name="password" placeholder="new password" autocomplete="new-password">
        <button type="submit" class="secondary">Set access</button>
      </form>
      <form method="post" action="/admin/sites/${esc(site.slug)}/domain">
        ${hidden(csrf)}
        <input type="text" name="domain" value="${esc(domain)}" placeholder="custom.example.com">
        <button type="submit" class="secondary">Set domain</button>
      </form>
      <form method="post" action="/admin/sites/${esc(site.slug)}/rollback">
        ${hidden(csrf)}
        <select name="version_id">${versionOptions}</select>
        <button type="submit" class="secondary">Activate</button>
      </form>
      <form method="post" action="/admin/sites/${esc(site.slug)}/delete"
            onsubmit="return confirm('Delete ${esc(site.slug)} and all versions?')">
        ${hidden(csrf)}
        <button type="submit" class="danger">Delete</button>
      </form>
    </div>
  </td>
</tr>`;
}

export type ConnectionEntry = {
  client: OAuthClientRow;
  name: string;
  redirectUris: string[];
  activeAccessTokens: number;
  activeRefreshTokens: number;
  lastIssuedAt: number | null;
};

export function connectionsPage(
  config: Config,
  entries: ConnectionEntry[],
  csrf: string,
  flash: { ok?: string; err?: string },
): string {
  const rows = entries
    .map(
      entry => `<tr>
  <td>${esc(entry.name)}<br><span class="mono">${esc(entry.client.client_id)}</span></td>
  <td>${entry.redirectUris.map(u => `<span class="mono">${esc(u)}</span>`).join('<br>')}</td>
  <td>${entry.activeAccessTokens} access<br>${entry.activeRefreshTokens} refresh</td>
  <td>${entry.lastIssuedAt ? esc(formatDate(entry.lastIssuedAt)) : '—'}</td>
  <td><form method="post" action="/admin/connections/${esc(entry.client.client_id)}/revoke"
        onsubmit="return confirm('Revoke this connection?')">
      ${hidden(csrf)}<button type="submit" class="danger">Revoke</button></form></td>
</tr>`,
    )
    .join('');

  const body = `${flashHtml(flash)}
<h1>Connections</h1>
<p>OAuth clients that have registered with this server. Revoking deletes the client and kills its tokens.</p>
${
  entries.length
    ? `<div class="scroll"><table>
<thead><tr><th>Client</th><th>Redirect URIs</th><th>Live tokens</th><th>Last token</th><th></th></tr></thead>
<tbody>${rows}</tbody></table></div>`
    : '<div class="card-block">No OAuth clients registered yet.</div>'
}
<h2>Connect a client</h2>
<div class="card-block">
  <p style="margin:0">MCP endpoint: <code>${esc(config.mcpUrl)}</code><br>
  Static token auth is ${config.apiToken ? 'enabled' : 'disabled'} (<code>A2W_API_TOKEN</code>).</p>
</div>
${logoutForm(csrf)}`;
  return page('agent2web — connections', body, NAV);
}

function hidden(csrf: string): string {
  return `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
}

function logoutForm(csrf: string): string {
  return `<form method="post" action="/admin/logout" style="margin-top:26px">${hidden(
    csrf,
  )}<button type="submit" class="secondary">Sign out</button></form>`;
}

function flashHtml(flash: { ok?: string; err?: string }): string {
  const parts: string[] = [];
  if (flash.ok) parts.push(`<div class="ok">${esc(flash.ok)}</div>`);
  if (flash.err) parts.push(`<div class="err">${esc(flash.err)}</div>`);
  return parts.join('');
}
