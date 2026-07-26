import type { Config } from '../config.js';
import type { FileRow, SiteRow, VersionRow } from '../../store.js';
import type { OAuthClientRow } from '../../http/admin.js';
import { card, page } from './layout.js';
import { esc, formatBytes, formatDate } from '../../util/html.js';
import { siteUrls } from '../urls.js';

const NAV = [
  { href: '/admin', label: 'Sites' },
  { href: '/admin/connections', label: 'Connections' },
];

/** Short form for badges, long form for the choices that set it. */
const ACCESS_BADGE: Record<string, string> = {
  public: 'Public',
  password: 'Password',
  disabled: 'Not served',
};

const ACCESS_LABEL: Record<string, string> = {
  public: 'Anyone with the link',
  password: 'Password required',
  disabled: 'Not served',
};

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
  versionCount: number;
  bytes: number;
};

/**
 * The list answers one question — what is published and who can reach it.
 * Everything that changes a site lives on its own page, where each control has
 * room for a label and a sentence saying what it does.
 */
export function sitesPage(
  config: Config,
  entries: SiteListEntry[],
  csrf: string,
  flash: { ok?: string; err?: string },
): string {
  const rows = entries
    .map(({ site, versionCount, bytes }) => {
      const urls = siteUrls(config, site);
      return `<tr>
  <td>
    <a class="plain mono" href="/admin/sites/${esc(site.slug)}"><strong>${esc(site.slug)}</strong></a>
    ${
      site.title && site.title.toLowerCase() !== site.slug.toLowerCase()
        ? `<div class="small muted">${esc(site.title)}</div>`
        : ''
    }
  </td>
  <td>${accessBadge(site.visibility)}</td>
  <td class="num">${versionCount}</td>
  <td class="num">${esc(formatBytes(bytes))}</td>
  <td class="num">${site.view_count}</td>
  <td class="small muted">${esc(formatDate(site.updated_at))}</td>
  <!-- The path URL is always served by this server, so the link cannot be broken
       by a custom domain whose DNS is not pointed here yet. -->
  <td class="num"><a href="${esc(urls.path)}" target="_blank" rel="noreferrer noopener">Open&nbsp;↗</a></td>
</tr>`;
    })
    .join('');

  const body = `${flashHtml(flash)}
<h1>Published sites</h1>
<p>Select a site to change who can see it, point a domain at it, or roll it back.</p>
${
  entries.length
    ? `<div class="scroll"><table>
<thead><tr>
  <th>Site</th><th>Access</th><th class="num">Versions</th><th class="num">Size</th>
  <th class="num">Views</th><th>Last published</th><th></th>
</tr></thead>
<tbody>${rows}</tbody></table></div>`
    : `<div class="panel">
  <h2>Nothing published yet</h2>
  <p class="help">Connect a client to <span class="mono">${esc(config.mcpUrl)}</span> and ask it to publish a page — the site appears here as soon as it does.</p>
</div>`
}
${logoutForm(csrf)}`;
  return page('agent2web — sites', body, NAV);
}

export type SiteDetail = {
  site: SiteRow;
  versions: VersionRow[];
  files: FileRow[];
};

export function siteDetailPage(
  config: Config,
  detail: SiteDetail,
  csrf: string,
  flash: { ok?: string; err?: string },
): string {
  const { site, versions, files } = detail;
  const urls = siteUrls(config, site);
  const slug = esc(site.slug);
  const current = versions.find(v => v.id === site.current_version_id);

  const urlRows = [
    ['Path', urls.path, ''],
    [
      'Subdomain',
      urls.subdomain,
      config.sitesBaseDomain ? '' : 'Set A2W_SITES_BASE_DOMAIN to serve every site on its own subdomain.',
    ],
    ['Custom domain', urls.custom, site.custom_domain ? '' : 'None set.'],
  ]
    .map(([label, url, note]) =>
      url
        ? `<dt>${esc(label)}</dt><dd><a class="mono" href="${esc(url)}" target="_blank" rel="noreferrer noopener">${esc(url)}</a></dd>`
        : `<dt>${esc(label)}</dt><dd class="small muted">${esc(note)}</dd>`,
    )
    .join('');

  const versionRows = versions
    .map(v => {
      const isCurrent = v.id === site.current_version_id;
      return `<tr>
  <td>${isCurrent ? '<span class="status status-public">Live</span>' : ''}</td>
  <td class="small muted">${esc(formatDate(v.created_at))}</td>
  <td class="small">${esc(v.note || '—')}</td>
  <td class="num small">${v.file_count} ${v.file_count === 1 ? 'file' : 'files'}</td>
  <td class="num small">${esc(formatBytes(v.bytes))}</td>
  <td class="num">${
    isCurrent
      ? ''
      : `<form method="post" action="/admin/sites/${slug}/rollback">${hidden(csrf)}
        <input type="hidden" name="version_id" value="${esc(v.id)}">
        <button type="submit" class="secondary">Make live</button></form>`
  }</td>
</tr>`;
    })
    .join('');

  const accessChoices = (['public', 'password', 'disabled'] as const)
    .map(
      value => `<div class="choice">
  <input type="radio" id="visibility-${value}" name="visibility" value="${value}"${
    site.visibility === value ? ' checked' : ''
  }>
  <div>
    <label for="visibility-${value}">${esc(ACCESS_LABEL[value]!)}</label>
    <p class="hint">${esc(accessHint(value))}</p>
  </div>
</div>`,
    )
    .join('');

  const body = `${flashHtml(flash)}
<a class="back" href="/admin">← All sites</a>
<div class="title-row">
  <h1 class="mono">${slug}</h1>
  ${accessBadge(site.visibility)}
</div>
<p>${site.title ? `${esc(site.title)} · ` : ''}${site.view_count} view${site.view_count === 1 ? '' : 's'} · last published ${esc(
    formatDate(site.updated_at),
  )}${current ? ` · ${current.file_count} ${current.file_count === 1 ? 'file' : 'files'}, ${esc(formatBytes(current.bytes))}` : ''}</p>

<div class="panel">
  <h2>Addresses</h2>
  <p class="help">All of these reach the same site, and all of them are live at once.</p>
  <dl class="urls">${urlRows}</dl>
</div>

<div class="panel">
  <h2>Who can see it</h2>
  <p class="help">Applies to every address above, immediately.</p>
  <form method="post" action="/admin/sites/${slug}/access">
    ${hidden(csrf)}
    <fieldset>${accessChoices}</fieldset>
    <div class="field">
      <label for="password">${site.password_hash ? 'Replace the password' : 'Set a password'}</label>
      <input id="password" name="password" type="password" autocomplete="new-password"
             placeholder="${site.password_hash ? 'Leave blank to keep the current one' : 'At least 6 characters'}">
      <p class="hint">${
        site.password_hash
          ? 'A password is set. Replacing it signs out everyone who unlocked the site with the old one.'
          : 'Required the first time you choose “Password required”.'
      }</p>
    </div>
    <button type="submit">Save access</button>
  </form>
</div>

<div class="panel">
  <h2>Custom domain</h2>
  <p class="help">The Worker answers for this hostname as soon as you save. Pointing DNS at it and getting a
  certificate is still yours to do — see docs/deploying.html.</p>
  <form method="post" action="/admin/sites/${slug}/domain">
    ${hidden(csrf)}
    <div class="field">
      <label for="domain">Hostname</label>
      <input id="domain" name="domain" type="text" value="${esc(site.custom_domain ?? '')}"
             placeholder="reports.example.com" spellcheck="false" autocapitalize="off">
      <p class="hint">Clear the field and save to remove the domain.</p>
    </div>
    <button type="submit">Save domain</button>
  </form>
</div>

<div class="panel">
  <h2>Versions</h2>
  <p class="help">Each publish keeps the previous files. Making an older version live swaps the site back
  without republishing; the ${config.keepVersions} most recent are kept.</p>
  <div class="scroll"><table>
    <thead><tr><th></th><th>Published</th><th>Note</th><th class="num">Files</th><th class="num">Size</th><th></th></tr></thead>
    <tbody>${versionRows}</tbody>
  </table></div>
</div>

<div class="panel">
  <h2>Files in the live version</h2>
  <p class="help">${files.length} ${files.length === 1 ? 'file' : 'files'} served right now.</p>
  <div class="scroll"><table>
    <thead><tr><th>Path</th><th>Type</th><th class="num">Size</th></tr></thead>
    <tbody>${
      files
        .map(
          f => `<tr>
      <td><a class="mono" href="${esc(urls.path)}${esc(f.path)}" target="_blank" rel="noreferrer noopener">${esc(f.path)}</a></td>
      <td class="small muted">${esc(f.content_type.split(';')[0] ?? '')}</td>
      <td class="num small">${esc(formatBytes(f.bytes))}</td>
    </tr>`,
        )
        .join('') || '<tr><td colspan="3" class="small muted">No files.</td></tr>'
    }</tbody>
  </table></div>
</div>

<div class="panel danger">
  <h2>Delete this site</h2>
  <p class="help">Removes ${slug}, every version and all of its files from disk. The addresses above start
  returning 404. This cannot be undone.</p>
  <form method="post" action="/admin/sites/${slug}/delete"
        ${confirmAttrs(
          `Delete ${site.slug} and its ${versions.length} version${versions.length === 1 ? '' : 's'}? This cannot be undone.`,
        )}>
    ${hidden(csrf)}
    <button type="submit" class="danger">Delete ${slug}</button>
  </form>
</div>

${logoutForm(csrf)}`;

  return page(`agent2web — ${site.slug}`, body, NAV);
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
  <td><strong>${esc(entry.name)}</strong><div class="small muted mono">${esc(entry.client.client_id)}</div></td>
  <td class="small mono">${entry.redirectUris.map(u => esc(u)).join('<br>')}</td>
  <td class="small">${
    entry.activeAccessTokens + entry.activeRefreshTokens > 0
      ? `${entry.activeAccessTokens} access · ${entry.activeRefreshTokens} refresh`
      : '<span class="muted">none</span>'
  }</td>
  <td class="small muted">${entry.lastIssuedAt ? esc(formatDate(entry.lastIssuedAt)) : 'never'}</td>
  <td class="num"><form method="post" action="/admin/connections/${esc(entry.client.client_id)}/revoke"
        ${confirmAttrs(`Revoke ${entry.name}? It will have to be authorized again.`)}>
      ${hidden(csrf)}<button type="submit" class="danger">Revoke</button></form></td>
</tr>`,
    )
    .join('');

  const body = `${flashHtml(flash)}
<h1>Connections</h1>
<p>Apps you have authorized to publish. Revoking one deletes it and kills its tokens immediately.</p>
${
  entries.length
    ? `<div class="scroll"><table>
<thead><tr><th>App</th><th>Sends codes to</th><th>Live tokens</th><th>Last token</th><th></th></tr></thead>
<tbody>${rows}</tbody></table></div>`
    : `<div class="panel">
  <h2>No apps authorized yet</h2>
  <p class="help">Add <span class="mono">${esc(config.mcpUrl)}</span> as a custom connector in Claude. You will
  be sent back here to sign in and approve it before it can publish anything.</p>
</div>`
}

<div class="panel">
  <h2>Connect an app</h2>
  <p class="help">Point any MCP client at this endpoint.</p>
  <dl class="urls">
    <dt>MCP endpoint</dt><dd class="mono">${esc(config.mcpUrl)}</dd>
    <dt>Static token</dt><dd class="small">${
      config.apiToken
        ? 'Enabled — send it as <span class="mono">Authorization: Bearer …</span> to skip the sign-in flow.'
        : 'Disabled. Set <span class="mono">A2W_API_TOKEN</span> to allow token auth for scripts and CI.'
    }</dd>
  </dl>
</div>
${logoutForm(csrf)}`;
  return page('agent2web — connections', body, NAV);
}

function accessBadge(visibility: string): string {
  return `<span class="status status-${esc(visibility)}">${esc(ACCESS_BADGE[visibility] ?? visibility)}</span>`;
}

function accessHint(visibility: 'public' | 'password' | 'disabled'): string {
  switch (visibility) {
    case 'public':
      return 'No password. Clears any password already set.';
    case 'password':
      return 'Visitors get a prompt before the page loads.';
    case 'disabled':
      return 'Returns 404 to visitors. Files and versions are kept.';
  }
}

/**
 * Attributes that make a form ask for confirmation first.
 *
 * The message travels in a data attribute rather than inside the handler,
 * because `esc()` is an HTML escaper and this would otherwise be a JavaScript
 * string context. The HTML parser decodes entities *before* the JS parser runs,
 * so an escaped apostrophe becomes a real one and closes the literal — a client
 * registering itself as `'+(...)+'` would get arbitrary script running on this
 * page. In a data attribute the escaping is correct and `dataset` hands the JS
 * the raw string, so the handler below stays a constant.
 */
function confirmAttrs(message: string): string {
  return `data-confirm="${esc(message)}" onsubmit="return confirm(this.dataset.confirm)"`;
}

function hidden(csrf: string): string {
  return `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
}

function logoutForm(csrf: string): string {
  return `<form method="post" action="/admin/logout" style="margin-top:28px">${hidden(
    csrf,
  )}<button type="submit" class="secondary">Sign out</button></form>`;
}

function flashHtml(flash: { ok?: string; err?: string }): string {
  const parts: string[] = [];
  if (flash.ok) parts.push(`<div class="ok">${esc(flash.ok)}</div>`);
  if (flash.err) parts.push(`<div class="err">${esc(flash.err)}</div>`);
  return parts.join('');
}
