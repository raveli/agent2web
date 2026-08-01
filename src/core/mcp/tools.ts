import { z } from 'zod';
import { decodeUtf8, toBase64 } from '../../util/bytes.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import type { InputFile, SiteStore, Visibility } from '../../store.js';
import { UserError } from '../../util/errors.js';
import { formatBytes, plural } from '../../util/html.js';
import { siteUrls } from '../urls.js';
import {
  fail,
  ok,
  responseFormat,
  siteLine,
  gatedSubresourceWarnings,
  siteSummary,
  versionLine,
  versionSummary,
  type ResponseFormat,
} from './format.js';

/**
 * Publishing to the open web is a one-way door — a link, once shared, cannot be
 * unshared — so it takes a deliberate second argument rather than a value the
 * model may have filled in without asking anyone.
 */
function requirePublicConfirmation(visibility: unknown, confirmed: unknown): void {
  if (visibility !== 'public' || confirmed === true) return;
  throw new UserError(
    'Refusing to make this site public without confirmation. Public means anyone with the link ' +
      'can read it, with no password, and a link that has been shared cannot be unshared. Ask the ' +
      'person you are working for, then pass confirm_public:true. Leaving visibility unset keeps ' +
      'the site password protected.',
  );
}

export type ToolContext = {
  config: Config;
  store: SiteStore;
};

const fileSchema = z.object({
  path: z
    .string()
    .describe('Relative path inside the site, e.g. "index.html" or "assets/app.css". No ".." or absolute paths.'),
  content: z.string().describe('File contents; base64-encode binary files and set encoding accordingly.'),
  encoding: z.enum(['utf8', 'base64']).default('utf8').describe('How `content` is encoded.'),
});

const slugArg = z.string().describe('Slug of the site, as returned by site_publish or site_list.');

export function registerSiteTools(server: McpServer, ctx: ToolContext): void {
  const { config, store } = ctx;
  const limits = `Limits: ${config.maxFiles} files, ${formatBytes(config.maxFileBytes)} per file, ${formatBytes(
    config.maxSiteBytes,
  )} per site.`;

  server.registerTool(
    'site_publish',
    {
      title: 'Publish a static site',
      description:
        'Publishes static files as a website and returns its public URL. Pass `html` for a single self-contained page, or `files` for a multi-file site (which must include "index.html"). ' +
        'If the slug already exists this adds a new version and switches the site to it, keeping the URL stable. ' +
        'New sites are password protected by default: pass `password` to choose one, or omit it and a ' +
        'readable password is generated and returned once. To publish something anyone with the link can ' +
        'read, set visibility:"public" AND confirm_public:true — ask the person you are working for first, ' +
        `because a link that has been shared cannot be unshared. ${limits}`,
      inputSchema: {
        slug: z
          .string()
          .optional()
          .describe(
            'URL slug: 1-63 lowercase letters, digits and single dashes. Derived from the title when omitted.',
          ),
        title: z.string().optional().describe('Human-readable title shown in listings and on the password page.'),
        html: z.string().optional().describe('Shorthand for a single-file site: the full HTML of index.html.'),
        files: z.array(fileSchema).optional().describe('Full file set for the site. Mutually exclusive with `html`.'),
        note: z.string().optional().describe('Short note describing this version, shown in site_list_versions.'),
        visibility: z
          .enum(['public', 'password', 'disabled'])
          .optional()
          .describe(
            'password (the default; one is generated if you pass none), public (anyone with the link — ' +
              'requires confirm_public), or disabled (returns 404 to visitors).',
          ),
        password: z
          .string()
          .optional()
          .describe('Sets a password and switches the site to password-protected access. Minimum 6 characters.'),
        confirm_public: z
          .boolean()
          .optional()
          .describe(
            'Required to publish with visibility:"public". Confirms the person you are working for accepts ' +
              'that anyone with the link can read this, with no password.',
          ),
        if_exists: z
          .enum(['new_version', 'fail'])
          .default('new_version')
          .describe('What to do when the slug already exists.'),
        response_format: responseFormat,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async args => {
      try {
        const files = filesFrom(args.html, args.files);
        if (args.password && args.password.length < 6) {
          throw new UserError('Site password must be at least 6 characters.');
        }
        requirePublicConfirmation(args.visibility, args.confirm_public);
        const result = await store.publish({
          slug: args.slug,
          title: args.title,
          files,
          note: args.note,
          visibility: args.visibility as Visibility | undefined,
          password: args.password ?? null,
          ifExists: args.if_exists,
        });
        const urls = siteUrls(config, result.site);
        const structured = {
          ...siteSummary(config, result.site),
          created: result.created,
          version: versionSummary(result.version),
          ...(result.generatedPassword ? { generated_password: result.generatedPassword } : {}),
        };
        const extra = [
          urls.subdomain && urls.subdomain !== urls.primary ? `Also at: ${urls.subdomain}` : undefined,
          urls.path !== urls.primary ? `Also at: ${urls.path}` : undefined,
          result.generatedPassword
            ? `Password (shown once, save it now): ${result.generatedPassword}`
            : result.site.visibility === 'password'
              ? 'Visitors must enter the site password.'
              : undefined,
          result.site.visibility === 'public' ? 'Anyone with the link can read this.' : undefined,
        ]
          .filter(Boolean)
          .join('\n');
        const paths = (await store.listFiles(result.version.id)).map(f => f.path);
        return ok(
          args.response_format as ResponseFormat,
          `${result.created ? 'Published' : 'Updated'} **${result.site.slug}** (${plural(
            result.version.file_count,
            'file',
          )}, ${formatBytes(result.version.bytes)})\n\n${urls.primary}\n${extra}`.trim(),
          structured,
          gatedSubresourceWarnings(result.site, paths),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'site_update_files',
    {
      title: 'Update files in a published site',
      description:
        'Creates a new version of an existing site by adding/replacing the files in `upsert` and deleting the paths in `remove`. ' +
        'Files not mentioned are carried over unchanged, so this is the cheap way to iterate on one page of a larger site.',
      inputSchema: {
        slug: slugArg,
        upsert: z.array(fileSchema).optional().describe('Files to add or replace.'),
        remove: z.array(z.string()).optional().describe('Paths to delete from the site.'),
        note: z.string().optional().describe('Short note describing this version.'),
        response_format: responseFormat,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async args => {
      try {
        const result = await store.updateFiles(
          args.slug,
          (args.upsert ?? []) as InputFile[],
          args.remove ?? [],
          args.note,
        );
        return ok(
          args.response_format as ResponseFormat,
          `Updated **${result.site.slug}** — version \`${result.version.id}\` now has ${plural(
            result.version.file_count,
            'file',
          )} (${formatBytes(result.version.bytes)}).\n\n${siteUrls(config, result.site).primary}`,
          { ...siteSummary(config, result.site), version: versionSummary(result.version) },
          gatedSubresourceWarnings(
            result.site,
            (await store.listFiles(result.version.id)).map(f => f.path),
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'site_list',
    {
      title: 'List published sites',
      description: 'Lists published sites, most recently updated first, with their URLs and protection state.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20).describe('Maximum sites to return.'),
        offset: z.number().int().min(0).default(0).describe('Number of sites to skip, for paging.'),
        response_format: responseFormat,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async args => {
      try {
        const { total, rows } = await store.listSites(args.limit, args.offset);
        const hasMore = args.offset + rows.length < total;
        const structured = {
          total,
          count: rows.length,
          offset: args.offset,
          has_more: hasMore,
          next_offset: hasMore ? args.offset + rows.length : null,
          sites: rows.map(site => siteSummary(config, site)),
        };
        const body = rows.length
          ? rows.map(site => siteLine(config, site)).join('\n')
          : 'No sites published yet. Use site_publish to create one.';
        const more = hasMore ? `\n\n${total - args.offset - rows.length} more — call again with offset ${
          args.offset + rows.length
        }.` : '';
        return ok(args.response_format as ResponseFormat, `${body}${more}`, structured);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'site_get',
    {
      title: 'Get one site',
      description: 'Returns a site’s URLs, access settings, current version and file list.',
      inputSchema: {
        slug: slugArg,
        include_files: z.boolean().default(true).describe('Include the file list of the current version.'),
        response_format: responseFormat,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async args => {
      try {
        const site = await store.requireSite(args.slug);
        const files = args.include_files && site.current_version_id
          ? await store.listFiles(site.current_version_id)
          : [];
        const versions = await store.listVersions(site.id, 5);
        const structured = {
          ...siteSummary(config, site),
          files: files.map(f => ({ path: f.path, bytes: f.bytes, content_type: f.content_type })),
          versions: versions.map(versionSummary),
        };
        const fileList = files.length
          ? `\n\nFiles:\n${files.map(f => `- ${f.path} (${formatBytes(f.bytes)})`).join('\n')}`
          : '';
        return ok(
          args.response_format as ResponseFormat,
          `${siteLine(config, site)}${fileList}`,
          structured,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'site_read_file',
    {
      title: 'Read a file from a site',
      description:
        'Returns the contents of one published file so it can be edited and re-published. Text files come back as text; binary files are base64-encoded. Long files are truncated to `max_bytes`.',
      inputSchema: {
        slug: slugArg,
        path: z.string().describe('Path of the file within the site, e.g. "index.html".'),
        version_id: z.string().optional().describe('Read from a specific version instead of the current one.'),
        max_bytes: z.number().int().min(1024).max(1024 * 1024).default(256 * 1024).describe('Truncation limit.'),
        response_format: responseFormat,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async args => {
      try {
        const file = await store.readSiteFile(args.slug, args.path, args.version_id, args.max_bytes);
        const isText =
          file.contentType.startsWith('text/') ||
          file.contentType.startsWith('application/json') ||
          file.contentType.startsWith('image/svg');
        // Uint8Array, not a Node Buffer: no toString(encoding) to lean on.
        const content = isText ? decodeUtf8(file.data) : toBase64(file.data);
        const structured = {
          slug: args.slug,
          path: file.path,
          content_type: file.contentType,
          bytes: file.bytes,
          truncated: file.truncated,
          encoding: isText ? 'utf8' : 'base64',
          content,
        };
        const header = `${file.path} — ${file.contentType}, ${formatBytes(file.bytes)}${
          file.truncated ? ' (truncated)' : ''
        }`;
        return ok(args.response_format as ResponseFormat, `${header}\n\n${content}`, structured);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'site_set_access',
    {
      title: 'Set site access',
      description:
        'Changes who can view a site: "public" (anyone with the link, clears any password), "password" (visitors must enter the password), or "disabled" (returns 404). ' +
        'Switching to "public" requires confirm_public:true — ask first. Switching to "password" without a password generates one and returns it once. ' +
        'Setting a new password immediately invalidates sessions unlocked with the old one.',
      inputSchema: {
        slug: slugArg,
        visibility: z.enum(['public', 'password', 'disabled']).describe('Desired access level.'),
        password: z
          .string()
          .optional()
          .describe('New password. Optional: one is generated when visibility is "password" and none is set.'),
        confirm_public: z
          .boolean()
          .optional()
          .describe(
            'Required for visibility:"public". Confirms the person you are working for accepts that anyone ' +
              'with the link can read this.',
          ),
        response_format: responseFormat,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async args => {
      try {
        requirePublicConfirmation(args.visibility, args.confirm_public);
        const { site, generatedPassword } = await store.setAccess(
          args.slug,
          args.visibility as Visibility,
          args.password ?? null,
        );
        const note =
          site.visibility === 'password'
            ? generatedPassword
              ? `Password (shown once, save it now): ${generatedPassword}`
              : 'Visitors now need the password. `curl -u :<password>` also works.'
            : site.visibility === 'disabled'
              ? 'The site now returns 404 to visitors; files are kept.'
              : 'The site is publicly readable.';
        const locked = site.current_version_id
          ? (await store.listFiles(site.current_version_id)).map(f => f.path)
          : [];
        return ok(
          args.response_format as ResponseFormat,
          `**${site.slug}** access set to \`${site.visibility}\`. ${note}`,
          {
            ...siteSummary(config, site),
            ...(generatedPassword ? { generated_password: generatedPassword } : {}),
          },
          gatedSubresourceWarnings(site, locked),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'site_rename',
    {
      title: 'Rename a site',
      description:
        'Changes a site’s slug and/or title. Changing the slug changes every URL of the site; the old URL stops working.',
      inputSchema: {
        slug: slugArg,
        new_slug: z.string().optional().describe('New slug. Omit to keep the current one.'),
        title: z.string().optional().describe('New title. Omit to keep the current one.'),
        response_format: responseFormat,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async args => {
      try {
        const site = await store.rename(args.slug, args.new_slug, args.title);
        return ok(
          args.response_format as ResponseFormat,
          `Renamed to **${site.slug}**.\n\n${siteUrls(config, site).primary}`,
          siteSummary(config, site),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'site_set_domain',
    {
      title: 'Set a custom domain',
      description:
        'Points a custom hostname at a site, or clears it when `domain` is omitted. The Worker starts answering for that Host immediately, ' +
        'but DNS and the certificate are the operator’s job: the returned instructions list the steps.',
      inputSchema: {
        slug: slugArg,
        domain: z.string().optional().describe('Hostname such as "reports.example.com". Omit to remove the domain.'),
        response_format: responseFormat,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async args => {
      try {
        const site = await store.setDomain(args.slug, args.domain ?? null);
        if (!site.custom_domain) {
          return ok(
            args.response_format as ResponseFormat,
            `Custom domain removed from **${site.slug}**. It is still served at ${siteUrls(config, site).primary}`,
            siteSummary(config, site),
          );
        }
        const steps = [
          `1. Add ${site.custom_domain} as a Custom Hostname (Cloudflare for SaaS) or, if you own the zone, a Workers route.`,
          `2. Point its DNS at this Worker: CNAME ${site.custom_domain} → ${config.publicOrigin.hostname}.`,
          '3. Cloudflare issues the certificate; the site answers on that host once it is active.',
        ];
        return ok(
          args.response_format as ResponseFormat,
          `**${site.slug}** will answer for https://${site.custom_domain}/ once DNS and TLS are in place.\n\n${steps.join(
            '\n',
          )}`,
          { ...siteSummary(config, site), setup_steps: steps },
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'site_list_versions',
    {
      title: 'List site versions',
      description: 'Lists the retained versions of a site, newest first. Older versions are pruned automatically.',
      inputSchema: {
        slug: slugArg,
        limit: z.number().int().min(1).max(100).default(20).describe('Maximum versions to return.'),
        response_format: responseFormat,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async args => {
      try {
        const site = await store.requireSite(args.slug);
        const versions = await store.listVersions(site.id, args.limit);
        return ok(
          args.response_format as ResponseFormat,
          versions.map(v => versionLine(v, v.id === site.current_version_id)).join('\n') || 'No versions yet.',
          {
            slug: site.slug,
            current_version_id: site.current_version_id,
            retained: config.keepVersions,
            count: versions.length,
            versions: versions.map(versionSummary),
          },
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'site_rollback',
    {
      title: 'Roll back to an earlier version',
      description: 'Switches a site back to a previously published version. The version must still be retained on disk.',
      inputSchema: {
        slug: slugArg,
        version_id: z.string().describe('Version to activate, from site_list_versions.'),
        response_format: responseFormat,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async args => {
      try {
        const { site, version } = await store.rollback(args.slug, args.version_id);
        return ok(
          args.response_format as ResponseFormat,
          `**${site.slug}** rolled back to \`${version.id}\` (${plural(version.file_count, 'file')}).\n\n${
            siteUrls(config, site).primary
          }`,
          { ...siteSummary(config, site), version: versionSummary(version) },
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'site_delete',
    {
      title: 'Delete a site',
      description:
        'Permanently deletes a site, all of its versions and all of its files from disk. Requires `confirm_slug` to equal `slug`. This cannot be undone.',
      inputSchema: {
        slug: slugArg,
        confirm_slug: z.string().describe('Repeat the slug to confirm deletion.'),
        response_format: responseFormat,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async args => {
      try {
        if (args.slug !== args.confirm_slug) {
          throw new UserError(
            `confirm_slug ("${args.confirm_slug}") must exactly match slug ("${args.slug}") to delete a site.`,
          );
        }
        const site = await store.deleteSite(args.slug);
        return ok(args.response_format as ResponseFormat, `Deleted **${site.slug}** and all of its versions.`, {
          slug: site.slug,
          deleted: true,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}

function filesFrom(html: string | undefined, files: unknown): InputFile[] {
  const list = (files ?? []) as InputFile[];
  if (html !== undefined && list.length > 0) {
    throw new UserError('Pass either `html` (single page) or `files` (multi-file site), not both.');
  }
  if (html !== undefined) return [{ path: 'index.html', content: html, encoding: 'utf8' }];
  if (list.length === 0) {
    throw new UserError('Provide `html` for a single page, or `files` for a multi-file site.');
  }
  return list;
}
