import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../config.js';
import type { SiteRow, VersionRow } from '../../store.js';
import { hasOwnOrigin, siteUrls } from '../urls.js';
import { formatBytes, formatDate } from '../../util/html.js';
import { subresourcePaths } from '../paths.js';
import { messageFor } from '../../util/errors.js';

export const responseFormat = z
  .enum(['markdown', 'json'])
  .default('markdown')
  .describe('markdown (default, compact and readable) or json (full structured data)');

export type ResponseFormat = 'markdown' | 'json';

/**
 * Builds a tool result carrying both a human-readable rendering and the
 * structured payload, so clients that understand outputSchema get real data.
 */
export function ok(
  format: ResponseFormat,
  markdown: string,
  structured: Record<string, unknown>,
  warnings: string[] = [],
): CallToolResult {
  // Warnings ride in both renderings: an agent reading markdown must not miss
  // something an agent reading JSON would see.
  const payload = warnings.length ? { ...structured, warnings } : structured;
  const text =
    format === 'json'
      ? JSON.stringify(payload, null, 2)
      : warnings.length
        ? `${markdown}\n\n${warnings.map(w => `Warning: ${w}`).join('\n')}`
        : markdown;
  return {
    content: [{ type: 'text', text }],
    structuredContent: payload,
  };
}

/**
 * Warns when a locked site carries files a browser fetches as subresources and
 * the site has no URL where those can load.
 *
 * On a path-based URL the page is sandboxed, which gives it an opaque origin,
 * and an opaque origin sends no cookies with subresource requests — the browser
 * reports ERR_BLOCKED_BY_ORB. On the site's own hostname there is no sandbox, so
 * same-origin CSS and JS carry the unlock cookie like any other request, and
 * path-based requests for the site are redirected there. Only when no hostname
 * exists (or sandboxing is forced) is a multi-file locked site broken.
 */
export function gatedSubresourceWarnings(config: Config, site: SiteRow, paths: string[]): string[] {
  if (site.visibility !== 'password') return [];
  if (hasOwnOrigin(config, site)) return [];
  const blocked = subresourcePaths(paths);
  if (blocked.length === 0) return [];
  const shown = blocked.slice(0, 8).join(', ');
  const more = blocked.length > 8 ? `, and ${blocked.length - 8} more` : '';
  return [
    `"${site.slug}" is password protected and only reachable on a path-based URL, so these files ` +
      `will not load for visitors: ${shown}${more}. A locked page there is sandboxed, which gives it ` +
      `an opaque origin, and an opaque origin sends no cookies with subresource requests — the browser ` +
      `reports ERR_BLOCKED_BY_ORB. Give the site its own hostname (set A2W_SITES_BASE_DOMAIN or a ` +
      `custom domain), republish as a single file with the CSS and JS inlined, or make the site public.`,
  ];
}

/** Tool failures are reported inside the result, per the MCP guidance. */
export function fail(err: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: messageFor(err) }] };
}

export function siteSummary(config: Config, site: SiteRow): Record<string, unknown> {
  const urls = siteUrls(config, site);
  return {
    slug: site.slug,
    title: site.title,
    url: urls.primary,
    urls: { path: urls.path, subdomain: urls.subdomain ?? null, custom: urls.custom ?? null },
    visibility: site.visibility,
    password_protected: site.visibility === 'password',
    custom_domain: site.custom_domain,
    current_version_id: site.current_version_id,
    view_count: site.view_count,
    created_at: new Date(site.created_at).toISOString(),
    updated_at: new Date(site.updated_at).toISOString(),
  };
}

export function versionSummary(version: VersionRow): Record<string, unknown> {
  return {
    version_id: version.id,
    note: version.note,
    bytes: version.bytes,
    file_count: version.file_count,
    created_at: new Date(version.created_at).toISOString(),
    created_by: version.actor ? { id: version.actor, label: version.actor_label } : null,
  };
}

export function siteLine(config: Config, site: SiteRow): string {
  const urls = siteUrls(config, site);
  const lock = site.visibility === 'password' ? ' 🔒' : site.visibility === 'disabled' ? ' (disabled)' : '';
  return `- **${site.slug}**${lock} — ${site.title || 'untitled'}\n  ${urls.primary}\n  updated ${formatDate(
    site.updated_at,
  )}, ${site.view_count} views`;
}

export function versionLine(version: VersionRow, current: boolean): string {
  return `- \`${version.id}\`${current ? ' (current)' : ''} — ${formatDate(version.created_at)}, ${
    version.file_count
  } files, ${formatBytes(version.bytes)}${by(version)}${version.note ? ` — ${version.note}` : ''}`;
}

function by(version: VersionRow): string {
  if (!version.actor) return '';
  return `, by ${version.actor_label ? `${version.actor_label} (${version.actor})` : version.actor}`;
}
