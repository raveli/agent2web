import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../config.js';
import type { SiteRow, VersionRow } from '../db.js';
import { siteUrls } from '../urls.js';
import { formatBytes, formatDate } from '../util/html.js';
import { messageFor } from '../util/errors.js';

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
): CallToolResult {
  return {
    content: [
      { type: 'text', text: format === 'json' ? JSON.stringify(structured, null, 2) : markdown },
    ],
    structuredContent: structured,
  };
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
  } files, ${formatBytes(version.bytes)}${version.note ? ` — ${version.note}` : ''}`;
}
