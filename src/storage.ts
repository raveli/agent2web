import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  cpSync,
} from 'node:fs';
import { isAbsolute, join, normalize, posix, resolve, sep } from 'node:path';
import mime from 'mime';
import type { Config } from './config.js';
import type { Db, FileRow, SiteRow, VersionRow } from './db.js';
import { hashPassword } from './auth/passwords.js';
import { UserError } from './util/errors.js';
import { isValidSlug, newId, RESERVED_SLUGS, slugify } from './util/ids.js';

export type InputFile = {
  path: string;
  content: string;
  encoding?: 'utf8' | 'base64';
};

export type PreparedFile = {
  path: string;
  data: Buffer;
  contentType: string;
  sha256: string;
};

export type Visibility = 'public' | 'password' | 'disabled';

const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 200;

/**
 * Turns caller-supplied file paths into a safe relative POSIX path, or throws a
 * UserError explaining exactly what was wrong. This is the only place that
 * decides what may become a filename, so every write goes through it.
 */
export function normalizeSitePath(input: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new UserError('File path must be a non-empty string, e.g. "index.html".');
  }
  let raw = input.trim();
  if (raw.includes('\0')) throw new UserError(`File path contains a NUL byte: ${JSON.stringify(input)}`);
  if (raw.includes('\\')) {
    throw new UserError(
      `File path must use forward slashes, got ${JSON.stringify(input)}. Example: "assets/app.css".`,
    );
  }
  if (/^[a-zA-Z]:/.test(raw) || raw.includes(':')) {
    throw new UserError(`File path must not contain ':' — got ${JSON.stringify(input)}.`);
  }
  raw = raw.replace(/^\/+/, '');
  if (raw === '') throw new UserError('File path must not be "/" — name a file such as "index.html".');
  if (raw.length > MAX_PATH_LENGTH) {
    throw new UserError(`File path is longer than ${MAX_PATH_LENGTH} characters.`);
  }

  const segments = raw.split('/');
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      throw new UserError(
        `File path must not contain empty or "." segments: ${JSON.stringify(input)}.`,
      );
    }
    if (segment === '..') {
      throw new UserError(`File path must not contain ".." segments: ${JSON.stringify(input)}.`);
    }
    if (segment.length > MAX_SEGMENT_LENGTH) {
      throw new UserError(`File path segment "${segment.slice(0, 32)}…" is too long.`);
    }
    if (/[\u0000-\u001f\u007f]/.test(segment)) {
      throw new UserError(`File path contains control characters: ${JSON.stringify(input)}.`);
    }
    out.push(segment);
  }

  const joined = out.join('/');
  // Belt and braces: normalize must not change anything and must stay relative.
  if (normalize(joined) !== joined || isAbsolute(joined)) {
    throw new UserError(`File path is not a safe relative path: ${JSON.stringify(input)}.`);
  }
  return joined;
}

/**
 * Resolves a relative path inside a root directory, refusing anything that
 * escapes the root even via symlinks in the caller-supplied portion.
 */
export function safeJoin(root: string, relativePath: string): string {
  const target = resolve(root, relativePath);
  const rootResolved = resolve(root);
  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) {
    throw new UserError(`Path escapes the site directory: ${JSON.stringify(relativePath)}.`);
  }
  return target;
}

function contentTypeFor(path: string): string {
  const type = mime.getType(path) ?? 'application/octet-stream';
  if (type.startsWith('text/') || type === 'application/json' || type === 'image/svg+xml') {
    return `${type}; charset=utf-8`;
  }
  return type;
}

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
};

export class SiteStore {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {
    mkdirSync(this.sitesRoot, { recursive: true });
  }

  get sitesRoot(): string {
    return join(this.config.dataDir, 'sites');
  }

  siteDir(siteId: string): string {
    return join(this.sitesRoot, siteId);
  }

  versionDir(siteId: string, versionId: string): string {
    return join(this.sitesRoot, siteId, versionId);
  }

  // ---------------------------------------------------------------- lookups

  getSiteBySlug(slug: string): SiteRow | undefined {
    return this.db.prepare('SELECT * FROM sites WHERE slug = ?').get(slug) as SiteRow | undefined;
  }

  getSiteById(id: string): SiteRow | undefined {
    return this.db.prepare('SELECT * FROM sites WHERE id = ?').get(id) as SiteRow | undefined;
  }

  getSiteByDomain(domain: string): SiteRow | undefined {
    return this.db.prepare('SELECT * FROM sites WHERE custom_domain = ?').get(domain.toLowerCase()) as
      | SiteRow
      | undefined;
  }

  requireSite(slug: string): SiteRow {
    const site = this.getSiteBySlug(slug);
    if (!site) {
      const known = (
        this.db.prepare('SELECT slug FROM sites ORDER BY updated_at DESC LIMIT 5').all() as {
          slug: string;
        }[]
      ).map(r => r.slug);
      const hint = known.length ? ` Known slugs include: ${known.join(', ')}.` : '';
      throw new UserError(`No site with slug "${slug}".${hint}`, 404);
    }
    return site;
  }

  listSites(limit: number, offset: number): { total: number; rows: SiteRow[] } {
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM sites').get() as { n: number };
    const rows = this.db
      .prepare('SELECT * FROM sites ORDER BY updated_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as SiteRow[];
    return { total: total.n, rows };
  }

  listVersions(siteId: string, limit = 50): VersionRow[] {
    return this.db
      .prepare('SELECT * FROM versions WHERE site_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(siteId, limit) as VersionRow[];
  }

  getVersion(siteId: string, versionId: string): VersionRow | undefined {
    return this.db
      .prepare('SELECT * FROM versions WHERE site_id = ? AND id = ?')
      .get(siteId, versionId) as VersionRow | undefined;
  }

  listFiles(versionId: string): FileRow[] {
    return this.db.prepare('SELECT * FROM files WHERE version_id = ? ORDER BY path').all(
      versionId,
    ) as FileRow[];
  }

  countSites(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM sites').get() as { n: number }).n;
  }

  // ------------------------------------------------------------- publishing

  /** Validates and hashes incoming files, enforcing the configured size limits. */
  prepareFiles(files: InputFile[]): PreparedFile[] {
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
        throw new UserError(`Unsupported encoding "${encoding}" for ${path}; use "utf8" or "base64".`);
      }
      if (typeof file.content !== 'string') {
        throw new UserError(`Content for ${path} must be a string.`);
      }
      const data = Buffer.from(file.content, encoding);
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
        sha256: createHash('sha256').update(data).digest('hex'),
      });
    }
    return [...seen.values()];
  }

  /**
   * Creates a site (or a new version of an existing one) from a complete file
   * set. Files land in a fresh version directory and the site only points at it
   * once every byte is on disk, so readers never observe a partial publish.
   */
  publish(options: PublishOptions): PublishResult {
    const prepared = this.prepareFiles(options.files);
    if (!prepared.some(f => f.path === 'index.html')) {
      throw new UserError(
        'A site must contain "index.html" so the root URL resolves. Add it, or rename your entry file.',
      );
    }

    const now = Date.now();
    let site = options.slug ? this.getSiteBySlug(options.slug) : undefined;
    let created = false;

    if (site && options.ifExists === 'fail') {
      throw new UserError(
        `Site "${site.slug}" already exists. Pass a different slug, or if_exists:"new_version" to publish over it.`,
      );
    }

    if (!site) {
      const slug = this.allocateSlug(options.slug, options.title);
      const id = newId();
      const visibility: Visibility = options.password
        ? 'password'
        : (options.visibility ?? 'public');
      this.db
        .prepare(
          `INSERT INTO sites (id, slug, title, visibility, password_hash, view_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          id,
          slug,
          options.title ?? slug,
          visibility,
          options.password ? hashPassword(options.password) : null,
          now,
          now,
        );
      site = this.getSiteById(id)!;
      created = true;
    }

    const versionId = newId();
    const dir = this.versionDir(site.id, versionId);
    try {
      for (const file of prepared) {
        const target = safeJoin(dir, file.path);
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, file.data);
      }
      const bytes = prepared.reduce((n, f) => n + f.data.byteLength, 0);
      this.commitVersion(site.id, versionId, {
        note: options.note ?? '',
        bytes,
        fileCount: prepared.length,
        files: prepared.map(f => ({
          path: f.path,
          bytes: f.data.byteLength,
          contentType: f.contentType,
          sha256: f.sha256,
        })),
        title: options.title,
        visibility: options.visibility,
        password: options.password,
        now,
      });
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      if (created) this.hardDelete(site.id);
      throw err;
    }

    this.prune(site.id);
    return {
      site: this.getSiteById(site.id)!,
      version: this.getVersion(site.id, versionId)!,
      created,
    };
  }

  /**
   * Publishes a new version derived from the current one: `upsert` replaces or
   * adds files, `remove` drops them, everything else is carried over.
   */
  updateFiles(
    slug: string,
    upsert: InputFile[],
    remove: string[],
    note?: string,
  ): PublishResult {
    const site = this.requireSite(slug);
    if (!site.current_version_id) {
      throw new UserError(`Site "${slug}" has no published version yet — use site_publish first.`);
    }
    if (upsert.length === 0 && remove.length === 0) {
      throw new UserError('Nothing to do — pass files to `upsert` and/or paths to `remove`.');
    }
    const currentFiles = this.listFiles(site.current_version_id);
    const removeSet = new Set(remove.map(normalizeSitePath));
    const upsertMap = new Map(
      (upsert.length ? this.prepareFiles(upsert) : []).map(f => [f.path, f] as const),
    );
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
      const data = readFileSync(safeJoin(this.versionDir(site.id, site.current_version_id), row.path));
      files.push({ path: row.path, content: data.toString('base64'), encoding: 'base64' });
    }
    for (const file of upsertMap.values()) {
      files.push({ path: file.path, content: file.data.toString('base64'), encoding: 'base64' });
    }
    if (files.length === 0) {
      throw new UserError('That would delete every file. Use site_delete to remove the site.');
    }
    return this.publish({ slug: site.slug, files, note, ifExists: 'new_version' });
  }

  private commitVersion(
    siteId: string,
    versionId: string,
    input: {
      note: string;
      bytes: number;
      fileCount: number;
      files: { path: string; bytes: number; contentType: string; sha256: string }[];
      title?: string;
      visibility?: Visibility;
      password?: string | null;
      now: number;
    },
  ): void {
    const insertVersion = this.db.prepare(
      `INSERT INTO versions (id, site_id, note, bytes, file_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertFile = this.db.prepare(
      `INSERT INTO files (version_id, path, bytes, content_type, sha256) VALUES (?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      insertVersion.run(versionId, siteId, input.note, input.bytes, input.fileCount, input.now);
      for (const file of input.files) {
        insertFile.run(versionId, file.path, file.bytes, file.contentType, file.sha256);
      }
      const sets: string[] = ['current_version_id = ?', 'updated_at = ?'];
      const params: unknown[] = [versionId, input.now];
      if (input.title !== undefined) {
        sets.push('title = ?');
        params.push(input.title);
      }
      if (input.password !== undefined && input.password !== null) {
        sets.push('password_hash = ?', 'visibility = ?');
        params.push(hashPassword(input.password), 'password');
      } else if (input.visibility !== undefined) {
        sets.push('visibility = ?');
        params.push(input.visibility);
        if (input.visibility === 'public') {
          sets.push('password_hash = NULL');
        }
      }
      params.push(siteId);
      this.db.prepare(`UPDATE sites SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    });
    tx();
  }

  private allocateSlug(requested: string | undefined, title: string | undefined): string {
    if (requested) {
      const slug = requested.trim().toLowerCase();
      if (!isValidSlug(slug)) {
        throw new UserError(
          `Invalid slug "${requested}". Use 1–63 lowercase letters, digits and single dashes, not starting or ending with a dash. Reserved: ${[
            ...RESERVED_SLUGS,
          ].join(', ')}.`,
        );
      }
      if (this.getSiteBySlug(slug)) {
        throw new UserError(`Slug "${slug}" is taken.`);
      }
      return slug;
    }
    const base = title ? slugify(title) : '';
    const candidate = base && isValidSlug(base) ? base : `site-${newId(6)}`;
    if (!this.getSiteBySlug(candidate)) return candidate;
    for (let i = 2; i < 100; i++) {
      const next = `${candidate.slice(0, 55)}-${i}`;
      if (isValidSlug(next) && !this.getSiteBySlug(next)) return next;
    }
    return `site-${newId(8)}`;
  }

  // ------------------------------------------------------------- management

  setAccess(slug: string, visibility: Visibility, password?: string | null): SiteRow {
    const site = this.requireSite(slug);
    if (visibility === 'password') {
      if (password) {
        if (password.length < 6) {
          throw new UserError('Site password must be at least 6 characters.');
        }
        this.db
          .prepare('UPDATE sites SET visibility = ?, password_hash = ?, updated_at = ? WHERE id = ?')
          .run('password', hashPassword(password), Date.now(), site.id);
      } else {
        if (!site.password_hash) {
          throw new UserError(
            `Site "${slug}" has no password set — pass a password to enable password protection.`,
          );
        }
        this.db
          .prepare('UPDATE sites SET visibility = ?, updated_at = ? WHERE id = ?')
          .run('password', Date.now(), site.id);
      }
    } else {
      this.db
        .prepare(
          'UPDATE sites SET visibility = ?, password_hash = NULL, updated_at = ? WHERE id = ?',
        )
        .run(visibility, Date.now(), site.id);
    }
    return this.getSiteById(site.id)!;
  }

  rename(slug: string, newSlug?: string, title?: string): SiteRow {
    const site = this.requireSite(slug);
    if (newSlug) {
      const next = newSlug.trim().toLowerCase();
      if (next !== site.slug) {
        if (!isValidSlug(next)) {
          throw new UserError(
            `Invalid slug "${newSlug}". Use 1–63 lowercase letters, digits and single dashes.`,
          );
        }
        if (this.getSiteBySlug(next)) throw new UserError(`Slug "${next}" is taken.`);
        this.db.prepare('UPDATE sites SET slug = ?, updated_at = ? WHERE id = ?').run(
          next,
          Date.now(),
          site.id,
        );
      }
    }
    if (title !== undefined) {
      this.db
        .prepare('UPDATE sites SET title = ?, updated_at = ? WHERE id = ?')
        .run(title, Date.now(), site.id);
    }
    return this.getSiteById(site.id)!;
  }

  setDomain(slug: string, domain?: string | null): SiteRow {
    const site = this.requireSite(slug);
    if (!domain) {
      this.db
        .prepare('UPDATE sites SET custom_domain = NULL, updated_at = ? WHERE id = ?')
        .run(Date.now(), site.id);
      return this.getSiteById(site.id)!;
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
    const existing = this.getSiteByDomain(normalized);
    if (existing && existing.id !== site.id) {
      throw new UserError(`Domain ${normalized} is already used by site "${existing.slug}".`);
    }
    this.db
      .prepare('UPDATE sites SET custom_domain = ?, updated_at = ? WHERE id = ?')
      .run(normalized, Date.now(), site.id);
    return this.getSiteById(site.id)!;
  }

  rollback(slug: string, versionId: string): { site: SiteRow; version: VersionRow } {
    const site = this.requireSite(slug);
    const version = this.getVersion(site.id, versionId);
    if (!version) {
      const available = this.listVersions(site.id, 5)
        .map(v => v.id)
        .join(', ');
      throw new UserError(
        `Version "${versionId}" not found for "${slug}". Recent versions: ${available || 'none'}.`,
        404,
      );
    }
    if (!existsSync(this.versionDir(site.id, versionId))) {
      throw new UserError(`Version "${versionId}" is no longer on disk (pruned).`, 410);
    }
    this.db
      .prepare('UPDATE sites SET current_version_id = ?, updated_at = ? WHERE id = ?')
      .run(versionId, Date.now(), site.id);
    return { site: this.getSiteById(site.id)!, version };
  }

  deleteSite(slug: string): SiteRow {
    const site = this.requireSite(slug);
    this.hardDelete(site.id);
    return site;
  }

  private hardDelete(siteId: string): void {
    this.db.prepare('DELETE FROM sites WHERE id = ?').run(siteId);
    rmSync(this.siteDir(siteId), { recursive: true, force: true });
  }

  /** Drops versions beyond A2W_KEEP_VERSIONS, never touching the current one. */
  prune(siteId: string): number {
    const site = this.getSiteById(siteId);
    if (!site) return 0;
    const versions = this.listVersions(siteId, 10_000);
    const keep = new Set<string>();
    if (site.current_version_id) keep.add(site.current_version_id);
    for (const version of versions) {
      if (keep.size >= this.config.keepVersions) break;
      keep.add(version.id);
    }
    let removed = 0;
    for (const version of versions) {
      if (keep.has(version.id)) continue;
      this.db.prepare('DELETE FROM versions WHERE id = ?').run(version.id);
      rmSync(this.versionDir(siteId, version.id), { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  readSiteFile(
    slug: string,
    filePath: string,
    versionId?: string,
    maxBytes = 256 * 1024,
  ): { path: string; contentType: string; bytes: number; truncated: boolean; data: Buffer } {
    const site = this.requireSite(slug);
    const version = versionId ?? site.current_version_id;
    if (!version) throw new UserError(`Site "${slug}" has no published version yet.`, 404);
    const path = normalizeSitePath(filePath);
    const row = this.db
      .prepare('SELECT * FROM files WHERE version_id = ? AND path = ?')
      .get(version, path) as FileRow | undefined;
    if (!row) {
      const available = this.listFiles(version)
        .slice(0, 20)
        .map(f => f.path)
        .join(', ');
      throw new UserError(`"${path}" is not in this version. Files: ${available || 'none'}.`, 404);
    }
    const absolute = safeJoin(this.versionDir(site.id, version), path);
    const data = readFileSync(absolute);
    const truncated = data.byteLength > maxBytes;
    return {
      path,
      contentType: row.content_type,
      bytes: data.byteLength,
      truncated,
      data: truncated ? data.subarray(0, maxBytes) : data,
    };
  }

  /**
   * Maps a request path within a site to a file on disk, applying directory
   * index resolution. Returns undefined when nothing matches.
   */
  resolveRequest(
    site: SiteRow,
    requestPath: string,
  ): { absolute: string; contentType: string; relative: string } | undefined {
    if (!site.current_version_id) return undefined;
    const root = this.versionDir(site.id, site.current_version_id);
    const decoded = decodeRequestPath(requestPath);
    if (decoded === undefined) return undefined;

    const candidates: string[] = [];
    if (decoded === '' || decoded.endsWith('/')) {
      candidates.push(posix.join(decoded, 'index.html'));
    } else {
      candidates.push(decoded, posix.join(decoded, 'index.html'), `${decoded}.html`);
    }

    for (const candidate of candidates) {
      let relative: string;
      try {
        relative = normalizeSitePath(candidate);
      } catch {
        continue;
      }
      let absolute: string;
      try {
        absolute = safeJoin(root, relative);
      } catch {
        continue;
      }
      if (existsSync(absolute) && statSync(absolute).isFile()) {
        const row = this.db
          .prepare('SELECT content_type FROM files WHERE version_id = ? AND path = ?')
          .get(site.current_version_id, relative) as { content_type: string } | undefined;
        return {
          absolute,
          relative,
          contentType: row?.content_type ?? contentTypeFor(relative),
        };
      }
    }
    return undefined;
  }

  /** Path of the site's custom 404 page, when it published one. */
  notFoundPage(site: SiteRow): string | undefined {
    if (!site.current_version_id) return undefined;
    try {
      const absolute = safeJoin(this.versionDir(site.id, site.current_version_id), '404.html');
      return existsSync(absolute) ? absolute : undefined;
    } catch {
      return undefined;
    }
  }

  recordView(siteId: string): void {
    this.db.prepare('UPDATE sites SET view_count = view_count + 1 WHERE id = ?').run(siteId);
  }

  /** Copies a version directory; used by tests and future duplicate support. */
  copyVersion(siteId: string, fromVersionId: string, toVersionId: string): void {
    cpSync(this.versionDir(siteId, fromVersionId), this.versionDir(siteId, toVersionId), {
      recursive: true,
    });
  }
}

/** Percent-decodes a URL path, rejecting anything that decodes to a traversal. */
export function decodeRequestPath(requestPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined;
  const stripped = decoded.replace(/^\/+/, '');
  if (stripped.split('/').some(segment => segment === '..')) return undefined;
  return stripped;
}
