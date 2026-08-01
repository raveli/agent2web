import type { R2Bucket } from '@cloudflare/workers-types';
import type { Config } from './core/config.js';
import type { WebCryptoProvider } from './core/crypto.js';
import { Sql, stmt, type Statement } from './d1.js';
import {
  blobKey,
  candidatesFor,
  contentTypeFor,
  normalizeSitePath,
  sitePrefix,
  versionPrefix,
} from './core/paths.js';
import { UserError } from './util/errors.js';
import { isValidSlug, newId, RESERVED_SLUGS, slugify } from './util/ids.js';

export type SiteRow = {
  id: string;
  slug: string;
  title: string;
  custom_domain: string | null;
  visibility: Visibility;
  password_hash: string | null;
  current_version_id: string | null;
  view_count: number;
  created_at: number;
  updated_at: number;
};

export type VersionRow = {
  id: string;
  site_id: string;
  note: string;
  bytes: number;
  file_count: number;
  created_at: number;
};

export type FileRow = {
  version_id: string;
  path: string;
  bytes: number;
  content_type: string;
  sha256: string;
};

export type Visibility = 'public' | 'password' | 'disabled';

export type InputFile = { path: string; content: string; encoding?: 'utf8' | 'base64' };

type PreparedFile = { path: string; data: Uint8Array; contentType: string; sha256: string };

export type PublishOptions = {
  slug?: string;
  title?: string;
  files: InputFile[];
  note?: string;
  visibility?: Visibility;
  password?: string | null;
  ifExists?: 'new_version' | 'fail';
};

export type PublishResult = {
  site: SiteRow;
  version: VersionRow;
  created: boolean;
  /** Set only when this call minted a password; it is not recoverable later. */
  generatedPassword?: string;
};

/** A file matched for serving: which object to stream and how to label it. */
export type ResolvedFile = { key: string; path: string; contentType: string };

export class SiteStore {
  private readonly sql: Sql;

  constructor(
    db: ConstructorParameters<typeof Sql>[0],
    private readonly blobs: R2Bucket,
    private readonly config: Config,
    private readonly crypto: WebCryptoProvider,
  ) {
    this.sql = new Sql(db);
  }

  // ---------------------------------------------------------------- lookups

  getSiteBySlug(slug: string): Promise<SiteRow | undefined> {
    return this.sql.first<SiteRow>('SELECT * FROM sites WHERE slug = ?', slug);
  }

  getSiteById(id: string): Promise<SiteRow | undefined> {
    return this.sql.first<SiteRow>('SELECT * FROM sites WHERE id = ?', id);
  }

  getSiteByDomain(domain: string): Promise<SiteRow | undefined> {
    return this.sql.first<SiteRow>(
      'SELECT * FROM sites WHERE custom_domain = ?',
      domain.toLowerCase(),
    );
  }

  async requireSite(slug: string): Promise<SiteRow> {
    const site = await this.getSiteBySlug(slug);
    if (!site) {
      const known = (
        await this.sql.all<{ slug: string }>(
          'SELECT slug FROM sites ORDER BY updated_at DESC LIMIT 5',
        )
      ).map(r => r.slug);
      const hint = known.length ? ` Known slugs include: ${known.join(', ')}.` : '';
      throw new UserError(`No site with slug "${slug}".${hint}`, 404);
    }
    return site;
  }

  async listSites(limit: number, offset: number): Promise<{ total: number; rows: SiteRow[] }> {
    const total = await this.sql.first<{ n: number }>('SELECT COUNT(*) AS n FROM sites');
    const rows = await this.sql.all<SiteRow>(
      'SELECT * FROM sites ORDER BY updated_at DESC LIMIT ? OFFSET ?',
      limit,
      offset,
    );
    return { total: total?.n ?? 0, rows };
  }

  listVersions(siteId: string, limit = 50): Promise<VersionRow[]> {
    return this.sql.all<VersionRow>(
      'SELECT * FROM versions WHERE site_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      siteId,
      limit,
    );
  }

  getVersion(siteId: string, versionId: string): Promise<VersionRow | undefined> {
    return this.sql.first<VersionRow>(
      'SELECT * FROM versions WHERE site_id = ? AND id = ?',
      siteId,
      versionId,
    );
  }

  listFiles(versionId: string): Promise<FileRow[]> {
    return this.sql.all<FileRow>(
      'SELECT * FROM files WHERE version_id = ? ORDER BY path',
      versionId,
    );
  }

  async countSites(): Promise<number> {
    return (await this.sql.first<{ n: number }>('SELECT COUNT(*) AS n FROM sites'))?.n ?? 0;
  }

  // ------------------------------------------------------------- publishing

  /** Validates and hashes incoming files, enforcing the configured size limits. */
  async prepareFiles(files: InputFile[]): Promise<PreparedFile[]> {
    if (!Array.isArray(files) || files.length === 0) {
      throw new UserError('Provide at least one file (or use the `html` shorthand).');
    }
    if (files.length > this.config.maxFiles) {
      throw new UserError(
        `Too many files: ${files.length} (limit ${this.config.maxFiles}). Split the site or raise A2W_MAX_FILES.`,
      );
    }
    const seen = new Map<string, PreparedFile>();
    let total = 0;
    for (const file of files) {
      const path = normalizeSitePath(file.path);
      const encoding = file.encoding ?? 'utf8';
      if (encoding !== 'utf8' && encoding !== 'base64') {
        throw new UserError(
          `Unsupported encoding "${encoding}" for ${path}; use "utf8" or "base64".`,
        );
      }
      if (typeof file.content !== 'string') {
        throw new UserError(`Content for ${path} must be a string.`);
      }
      const data = decode(file.content, encoding, path);
      if (data.byteLength > this.config.maxFileBytes) {
        throw new UserError(
          `${path} is ${data.byteLength} bytes, over the ${this.config.maxFileBytes} byte per-file limit.`,
        );
      }
      total += data.byteLength;
      if (total > this.config.maxSiteBytes) {
        throw new UserError(
          `Site exceeds the ${this.config.maxSiteBytes} byte total limit. Remove files or raise A2W_MAX_SITE_BYTES.`,
        );
      }
      seen.set(path, {
        path,
        data,
        contentType: contentTypeFor(path),
        sha256: await this.crypto.sha256Hex(data),
      });
    }
    return [...seen.values()];
  }

  /**
   * Creates a site, or a new version of an existing one, from a complete file set.
   *
   * Every object is written before the site is pointed at the new version, and
   * that pointer moves in a single batch alongside the version and file rows. A
   * reader therefore never observes a half-published site, which is the same
   * guarantee the filesystem version gave by writing into a fresh directory.
   */
  async publish(options: PublishOptions): Promise<PublishResult> {
    const prepared = await this.prepareFiles(options.files);
    if (!prepared.some(f => f.path === 'index.html')) {
      throw new UserError(
        'A site must contain "index.html" so the root URL resolves. Add it, or rename your entry file.',
      );
    }

    const now = Date.now();
    let site = options.slug ? await this.getSiteBySlug(options.slug) : undefined;
    let created = false;

    if (site && options.ifExists === 'fail') {
      throw new UserError(
        `Site "${site.slug}" already exists. Pass a different slug, or if_exists:"new_version" to publish over it.`,
      );
    }

    // A new site is protected unless the caller asked for something else. This
    // product turns things you would not publish into pages, so an omitted
    // argument has to fail closed.
    let generatedPassword: string | undefined;
    if (!site) {
      const slug = await this.allocateSlug(options.slug, options.title);
      const id = newId();
      const visibility: Visibility = options.password
        ? 'password'
        : (options.visibility ?? 'password');

      // Protected with no password used to store a null hash, which denies
      // every request forever. Mint one instead and hand it back.
      let password = options.password ?? undefined;
      if (visibility === 'password' && !password) {
        password = this.crypto.readablePassword();
        generatedPassword = password;
      }

      await this.sql.run(
        `INSERT INTO sites (id, slug, title, visibility, password_hash, view_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
        id,
        slug,
        options.title ?? slug,
        visibility,
        password ? await this.crypto.hashPassword(password) : null,
        now,
        now,
      );
      site = (await this.getSiteById(id))!;
      created = true;
    }

    const versionId = newId();
    try {
      for (const file of prepared) {
        await this.blobs.put(blobKey(site.id, versionId, file.path), file.data as never, {
          httpMetadata: { contentType: file.contentType },
        });
      }
      await this.commitVersion(site, versionId, prepared, options, now);
    } catch (err) {
      await this.blobs.delete(
        (await this.listKeys(versionPrefix(site.id, versionId))) as never,
      ).catch(() => {});
      if (created) await this.hardDelete(site.id);
      throw err;
    }

    await this.prune(site.id);
    return {
      site: (await this.getSiteById(site.id))!,
      version: (await this.getVersion(site.id, versionId))!,
      created,
      generatedPassword,
    };
  }

  /**
   * Publishes a new version derived from the current one: `upsert` replaces or
   * adds files, `remove` drops them, everything else is carried over.
   */
  async updateFiles(
    slug: string,
    upsert: InputFile[],
    remove: string[],
    note?: string,
  ): Promise<PublishResult> {
    const site = await this.requireSite(slug);
    if (!site.current_version_id) {
      throw new UserError(`Site "${slug}" has no published version yet — use site_publish first.`);
    }
    if (upsert.length === 0 && remove.length === 0) {
      throw new UserError('Nothing to do — pass files to `upsert` and/or paths to `remove`.');
    }

    const currentFiles = await this.listFiles(site.current_version_id);
    const removeSet = new Set(remove.map(normalizeSitePath));
    const upserted = upsert.length ? await this.prepareFiles(upsert) : [];
    const upsertMap = new Map(upserted.map(f => [f.path, f] as const));

    for (const path of removeSet) {
      if (!currentFiles.some(f => f.path === path) && !upsertMap.has(path)) {
        throw new UserError(
          `Cannot remove "${path}" — it is not in the current version. Use site_get to list files.`,
        );
      }
    }

    const files: InputFile[] = [];
    for (const row of currentFiles) {
      if (removeSet.has(row.path) || upsertMap.has(row.path)) continue;
      const object = await this.blobs.get(blobKey(site.id, site.current_version_id, row.path));
      if (!object) continue;
      const bytes = new Uint8Array(await object.arrayBuffer());
      files.push({ path: row.path, content: encodeBase64(bytes), encoding: 'base64' });
    }
    for (const file of upsertMap.values()) {
      files.push({ path: file.path, content: encodeBase64(file.data), encoding: 'base64' });
    }
    if (files.length === 0) {
      throw new UserError('That would delete every file. Use site_delete to remove the site.');
    }
    return this.publish({ slug: site.slug, files, note, ifExists: 'new_version' });
  }

  private async commitVersion(
    site: SiteRow,
    versionId: string,
    files: PreparedFile[],
    options: PublishOptions,
    now: number,
  ): Promise<void> {
    const bytes = files.reduce((n, f) => n + f.data.byteLength, 0);
    const statements: Statement[] = [
      stmt(
        `INSERT INTO versions (id, site_id, note, bytes, file_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        versionId,
        site.id,
        options.note ?? '',
        bytes,
        files.length,
        now,
      ),
    ];
    for (const file of files) {
      statements.push(
        stmt(
          `INSERT INTO files (version_id, path, bytes, content_type, sha256) VALUES (?, ?, ?, ?, ?)`,
          versionId,
          file.path,
          file.data.byteLength,
          file.contentType,
          file.sha256,
        ),
      );
    }

    const sets = ['current_version_id = ?', 'updated_at = ?'];
    const params: unknown[] = [versionId, now];
    if (options.title !== undefined) {
      sets.push('title = ?');
      params.push(options.title);
    }
    if (options.password) {
      sets.push('password_hash = ?', 'visibility = ?');
      params.push(await this.crypto.hashPassword(options.password), 'password');
    } else if (options.visibility !== undefined) {
      sets.push('visibility = ?');
      params.push(options.visibility);
      if (options.visibility === 'public') sets.push('password_hash = NULL');
    }
    params.push(site.id);
    statements.push(stmt(`UPDATE sites SET ${sets.join(', ')} WHERE id = ?`, ...params));

    await this.sql.batch(statements);
  }

  private async allocateSlug(requested: string | undefined, title: string | undefined) {
    if (requested) {
      const slug = requested.trim().toLowerCase();
      if (!isValidSlug(slug)) {
        throw new UserError(
          `Invalid slug "${requested}". Use 1–63 lowercase letters, digits and single dashes, not starting or ending with a dash. Reserved: ${[
            ...RESERVED_SLUGS,
          ].join(', ')}.`,
        );
      }
      if (await this.getSiteBySlug(slug)) throw new UserError(`Slug "${slug}" is taken.`);
      return slug;
    }
    const base = title ? slugify(title) : '';
    const candidate = base && isValidSlug(base) ? base : `site-${newId(6)}`;
    if (!(await this.getSiteBySlug(candidate))) return candidate;
    for (let i = 2; i < 100; i++) {
      const next = `${candidate.slice(0, 55)}-${i}`;
      if (isValidSlug(next) && !(await this.getSiteBySlug(next))) return next;
    }
    return `site-${newId(8)}`;
  }

  // ------------------------------------------------------------- management

  async setAccess(slug: string, visibility: Visibility, password?: string | null) {
    const site = await this.requireSite(slug);
    let generated: string | undefined;
    if (visibility === 'password') {
      if (password) {
        if (password.length < 6) throw new UserError('Site password must be at least 6 characters.');
        await this.sql.run(
          'UPDATE sites SET visibility = ?, password_hash = ?, updated_at = ? WHERE id = ?',
          'password',
          await this.crypto.hashPassword(password),
          Date.now(),
          site.id,
        );
      } else if (site.password_hash) {
        await this.sql.run(
          'UPDATE sites SET visibility = ?, updated_at = ? WHERE id = ?',
          'password',
          Date.now(),
          site.id,
        );
      } else {
        // Locking a site that has never had a password: mint one rather than
        // refuse, so the caller always ends up with something that opens.
        generated = this.crypto.readablePassword();
        await this.sql.run(
          'UPDATE sites SET visibility = ?, password_hash = ?, updated_at = ? WHERE id = ?',
          'password',
          await this.crypto.hashPassword(generated),
          Date.now(),
          site.id,
        );
      }
    } else {
      await this.sql.run(
        'UPDATE sites SET visibility = ?, password_hash = NULL, updated_at = ? WHERE id = ?',
        visibility,
        Date.now(),
        site.id,
      );
    }
    return { site: (await this.getSiteById(site.id))!, generatedPassword: generated };
  }

  async rename(slug: string, newSlug?: string, title?: string): Promise<SiteRow> {
    const site = await this.requireSite(slug);
    if (newSlug) {
      const next = newSlug.trim().toLowerCase();
      if (next !== site.slug) {
        if (!isValidSlug(next)) {
          throw new UserError(
            `Invalid slug "${newSlug}". Use 1–63 lowercase letters, digits and single dashes.`,
          );
        }
        if (await this.getSiteBySlug(next)) throw new UserError(`Slug "${next}" is taken.`);
        await this.sql.run(
          'UPDATE sites SET slug = ?, updated_at = ? WHERE id = ?',
          next,
          Date.now(),
          site.id,
        );
      }
    }
    if (title !== undefined) {
      await this.sql.run(
        'UPDATE sites SET title = ?, updated_at = ? WHERE id = ?',
        title,
        Date.now(),
        site.id,
      );
    }
    return (await this.getSiteById(site.id))!;
  }

  async setDomain(slug: string, domain?: string | null): Promise<SiteRow> {
    const site = await this.requireSite(slug);
    if (!domain) {
      await this.sql.run(
        'UPDATE sites SET custom_domain = NULL, updated_at = ? WHERE id = ?',
        Date.now(),
        site.id,
      );
      return (await this.getSiteById(site.id))!;
    }
    const normalized = domain.trim().toLowerCase().replace(/\.$/, '');
    if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(normalized)) {
      throw new UserError(`"${domain}" is not a valid hostname, e.g. "reports.example.com".`);
    }
    if (normalized === this.config.publicOrigin.hostname) {
      throw new UserError('That is the app hostname; pick a different domain for the site.');
    }
    if (this.config.sitesBaseDomain && normalized.endsWith(`.${this.config.sitesBaseDomain}`)) {
      throw new UserError(
        `Hosts under ${this.config.sitesBaseDomain} are already served automatically as <slug>.${this.config.sitesBaseDomain}.`,
      );
    }
    const existing = await this.getSiteByDomain(normalized);
    if (existing && existing.id !== site.id) {
      throw new UserError(`Domain ${normalized} is already used by site "${existing.slug}".`);
    }
    await this.sql.run(
      'UPDATE sites SET custom_domain = ?, updated_at = ? WHERE id = ?',
      normalized,
      Date.now(),
      site.id,
    );
    return (await this.getSiteById(site.id))!;
  }

  async rollback(slug: string, versionId: string) {
    const site = await this.requireSite(slug);
    const version = await this.getVersion(site.id, versionId);
    if (!version) {
      const available = (await this.listVersions(site.id, 5)).map(v => v.id).join(', ');
      throw new UserError(
        `Version "${versionId}" not found for "${slug}". Recent versions: ${available || 'none'}.`,
        404,
      );
    }
    await this.sql.run(
      'UPDATE sites SET current_version_id = ?, updated_at = ? WHERE id = ?',
      versionId,
      Date.now(),
      site.id,
    );
    return { site: (await this.getSiteById(site.id))!, version };
  }

  async deleteSite(slug: string): Promise<SiteRow> {
    const site = await this.requireSite(slug);
    await this.hardDelete(site.id);
    return site;
  }

  private async hardDelete(siteId: string): Promise<void> {
    await this.sql.run('DELETE FROM sites WHERE id = ?', siteId);
    await this.deleteByPrefix(sitePrefix(siteId));
  }

  /** Drops versions beyond A2W_KEEP_VERSIONS, never touching the current one. */
  async prune(siteId: string): Promise<number> {
    const site = await this.getSiteById(siteId);
    if (!site) return 0;
    const versions = await this.listVersions(siteId, 10_000);
    const keep = new Set<string>();
    if (site.current_version_id) keep.add(site.current_version_id);
    for (const version of versions) {
      if (keep.size >= this.config.keepVersions) break;
      keep.add(version.id);
    }
    let removed = 0;
    for (const version of versions) {
      if (keep.has(version.id)) continue;
      await this.sql.run('DELETE FROM versions WHERE id = ?', version.id);
      await this.deleteByPrefix(versionPrefix(siteId, version.id));
      removed += 1;
    }
    return removed;
  }

  async readSiteFile(slug: string, filePath: string, versionId?: string, maxBytes = 256 * 1024) {
    const site = await this.requireSite(slug);
    const version = versionId ?? site.current_version_id;
    if (!version) throw new UserError(`Site "${slug}" has no published version yet.`, 404);
    const path = normalizeSitePath(filePath);
    const row = await this.sql.first<FileRow>(
      'SELECT * FROM files WHERE version_id = ? AND path = ?',
      version,
      path,
    );
    if (!row) {
      const available = (await this.listFiles(version))
        .slice(0, 20)
        .map(f => f.path)
        .join(', ');
      throw new UserError(`"${path}" is not in this version. Files: ${available || 'none'}.`, 404);
    }
    const object = await this.blobs.get(blobKey(site.id, version, path));
    if (!object) throw new UserError(`"${path}" is recorded but missing from storage.`, 410);
    const all = new Uint8Array(await object.arrayBuffer());
    const truncated = all.byteLength > maxBytes;
    return {
      path,
      contentType: row.content_type,
      bytes: all.byteLength,
      truncated,
      data: truncated ? all.subarray(0, maxBytes) : all,
    };
  }

  /**
   * Maps a request path within a site to the object that should answer it.
   *
   * The candidate list is resolved with one query against `files` rather than a
   * HEAD per candidate, so a miss costs one round trip instead of three.
   */
  async resolveRequest(site: SiteRow, requestPath: string): Promise<ResolvedFile | undefined> {
    if (!site.current_version_id) return undefined;
    const candidates = candidatesFor(requestPath);
    if (candidates.length === 0) return undefined;

    const placeholders = candidates.map(() => '?').join(', ');
    const rows = await this.sql.all<{ path: string; content_type: string }>(
      `SELECT path, content_type FROM files WHERE version_id = ? AND path IN (${placeholders})`,
      site.current_version_id,
      ...candidates,
    );
    if (rows.length === 0) return undefined;

    // Preserve candidate priority: exact path beats directory index beats .html.
    for (const candidate of candidates) {
      const row = rows.find(r => r.path === candidate);
      if (!row) continue;
      return {
        key: blobKey(site.id, site.current_version_id, row.path),
        path: row.path,
        contentType: row.content_type,
      };
    }
    return undefined;
  }

  /** The site's own 404 page, when it published one. */
  async notFoundPage(site: SiteRow): Promise<ResolvedFile | undefined> {
    if (!site.current_version_id) return undefined;
    const row = await this.sql.first<FileRow>(
      'SELECT * FROM files WHERE version_id = ? AND path = ?',
      site.current_version_id,
      '404.html',
    );
    if (!row) return undefined;
    return {
      key: blobKey(site.id, site.current_version_id, '404.html'),
      path: '404.html',
      contentType: row.content_type,
    };
  }

  openBlob(key: string) {
    return this.blobs.get(key);
  }

  recordView(siteId: string): Promise<void> {
    return this.sql.run('UPDATE sites SET view_count = view_count + 1 WHERE id = ?', siteId);
  }

  // R2 deletes take up to 1000 keys at a time and there is no prefix delete.
  private async deleteByPrefix(prefix: string): Promise<void> {
    const keys = await this.listKeys(prefix);
    for (let i = 0; i < keys.length; i += 1000) {
      await this.blobs.delete(keys.slice(i, i + 1000) as never);
    }
  }

  private async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.blobs.list({ prefix, cursor, limit: 1000 });
      for (const object of page.objects) keys.push(object.key);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return keys;
  }
}

function decode(content: string, encoding: 'utf8' | 'base64', path: string): Uint8Array {
  if (encoding === 'utf8') return new TextEncoder().encode(content);
  try {
    const binary = atob(content.replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    throw new UserError(`Content for ${path} is not valid base64.`);
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
