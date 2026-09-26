import type { FixedLengthStream as FixedLengthStreamClass, R2Bucket } from '@cloudflare/workers-types';
import type { Config } from './core/config.js';
import type { WebCryptoProvider } from './core/crypto.js';
import { Sql, stmt, type Statement } from './d1.js';
import {
  blobKey,
  candidatesFor,
  contentTypeFor,
  normalizeSitePath,
  sitePrefix,
  stagingKey,
  stagingPrefix,
  versionPrefix,
} from './core/paths.js';
import { decodeUtf8 } from './util/bytes.js';
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
  /** Who created it: "api-token", "oauth:<client id>", or null for versions from before #16. */
  actor: string | null;
  /** A readable name for the actor at the time, e.g. the OAuth client's name. */
  actor_label: string | null;
};

/** The caller a store acts for, recorded on every version it creates. */
export type Actor = { id: string; label?: string };

export type FileRow = {
  version_id: string;
  path: string;
  bytes: number;
  content_type: string;
  sha256: string;
};

export type Visibility = 'public' | 'password' | 'disabled';

export type InputFile = { path: string; content: string; encoding?: 'utf8' | 'base64' };

/** One exact-text replacement, in the spirit of an editor's find-and-replace. */
export type FileEdit = { old_text: string; new_text: string; replace_all?: boolean };

/** Moves the text between two markers of a file into a file of its own. */
export type Extraction = { to: string; start: string; end: string; replace_with: string };

type PreparedFile = { path: string; data: Uint8Array; contentType: string; sha256: string };

/** What a version records about each of its files. */
type StoredFile = { path: string; bytes: number; contentType: string; sha256: string };

/** A file an update leaves alone, copied object to object from the version before. */
type CarriedFile = StoredFile & { fromKey: string };

// A Workers global; the types are imported per module rather than ambiently.
declare const FixedLengthStream: typeof FixedLengthStreamClass;

export type PublishOptions = {
  slug?: string;
  title?: string;
  files: InputFile[];
  /** Paths assembled earlier with stageFile, added to `files` and cleared on success. */
  staged?: string[];
  /** Files of the current version to copy into the new one unchanged (updateFiles). */
  carry?: CarriedFile[];
  /** Only publish if the site's live version is still this one (optimistic concurrency). */
  ifVersion?: string;
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
    private readonly db: ConstructorParameters<typeof Sql>[0],
    private readonly blobs: R2Bucket,
    private readonly config: Config,
    private readonly crypto: WebCryptoProvider,
    private readonly actor?: Actor,
  ) {
    this.sql = new Sql(db);
  }

  /** The same store, recording `actor` on the versions it creates. */
  as(actor: Actor): SiteStore {
    return new SiteStore(this.db, this.blobs, this.config, this.crypto, actor);
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
    if (options.staged?.length) {
      if (!options.slug) throw new UserError('Staged files belong to a slug — pass the `slug` you staged them under.');
      const slug = options.slug.trim().toLowerCase();
      const staged = await this.loadStaged(slug, options.staged);
      const result = await this.publish({
        ...options,
        files: [...options.files, ...staged],
        staged: undefined,
      });
      await this.clearStaged(slug, options.staged);
      return result;
    }
    const carry = options.carry ?? [];
    const prepared =
      options.files.length === 0 && carry.length > 0 ? [] : await this.prepareFiles(options.files);
    const stored: StoredFile[] = [
      ...prepared.map(f => ({ path: f.path, bytes: f.data.byteLength, contentType: f.contentType, sha256: f.sha256 })),
      ...carry,
    ];
    if (carry.length) this.checkTotals(stored);
    if (!stored.some(f => f.path === 'index.html')) {
      throw new UserError(
        'A site must contain "index.html" so the root URL resolves. Add it, or rename your entry file.',
      );
    }

    const now = Date.now();
    let site = options.slug ? await this.getSiteBySlug(options.slug) : undefined;
    let created = false;

    if (options.ifVersion !== undefined) {
      if (!site) throw new UserError(`if_version was given, but there is no site "${options.slug}" yet.`, 404);
      if (site.current_version_id !== options.ifVersion) throw await this.versionConflict(site, options.ifVersion);
    }

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
      for (const file of carry) await this.copyObject(file, blobKey(site.id, versionId, file.path));
      await this.commitVersion(site, versionId, stored, options, now);
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
    staged: string[] = [],
    ifVersion?: string,
  ): Promise<PublishResult> {
    const site = await this.requireSite(slug);
    if (!site.current_version_id) {
      throw new UserError(`Site "${slug}" has no published version yet — use site_publish first.`);
    }
    if (staged.length) {
      const loaded = await this.loadStaged(site.slug, staged);
      const result = await this.updateFiles(slug, [...upsert, ...loaded], remove, note, [], ifVersion);
      await this.clearStaged(site.slug, staged);
      return result;
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

    // Carried files are copied object to object rather than read into the
    // isolate: a 5 MB site used to cost ~177 MB of heap in base64 round trips.
    const carry: CarriedFile[] = currentFiles
      .filter(row => !removeSet.has(row.path) && !upsertMap.has(row.path))
      .map(row => ({
        path: row.path,
        bytes: row.bytes,
        contentType: row.content_type,
        sha256: row.sha256,
        fromKey: blobKey(site.id, site.current_version_id!, row.path),
      }));
    if (carry.length === 0 && upserted.length === 0) {
      throw new UserError('That would delete every file. Use site_delete to remove the site.');
    }
    return this.publish({ slug: site.slug, files: upsert, carry, note, ifExists: 'new_version', ifVersion });
  }

  /**
   * Applies exact-text replacements to one text file of the current version and
   * publishes the result, so a change costs the size of the change rather than
   * the size of the file. Every edit must apply or none do.
   */
  async editFile(
    slug: string,
    filePath: string,
    edits: FileEdit[],
    note?: string,
    ifVersion?: string,
  ): Promise<PublishResult> {
    if (edits.length === 0) throw new UserError('Pass at least one edit.');
    const file = await this.readSiteFile(slug, filePath, undefined, Infinity);
    if (!isTextType(file.contentType)) {
      throw new UserError(`${file.path} is ${file.contentType}, not text; replace it with site_update_files.`);
    }
    let text = decodeUtf8(file.data);
    edits.forEach((edit, i) => {
      const label = edits.length > 1 ? `Edit ${i + 1}: ` : '';
      if (edit.old_text === '') throw new UserError(`${label}old_text must not be empty.`);
      const count = text.split(edit.old_text).length - 1;
      if (count === 0) {
        throw new UserError(
          `${label}old_text was not found in ${file.path}. It must match the published file exactly, ` +
            'whitespace included — re-read it with site_read_file. Nothing was changed.',
        );
      }
      if (count > 1 && !edit.replace_all) {
        throw new UserError(
          `${label}old_text occurs ${count} times in ${file.path}. Include more surrounding text so it ` +
            'is unique, or pass replace_all:true. Nothing was changed.',
        );
      }
      // A function replacement, so "$&" and friends in new_text stay literal.
      text = edit.replace_all
        ? text.split(edit.old_text).join(edit.new_text)
        : text.replace(edit.old_text, () => edit.new_text);
    });
    return this.updateFiles(slug, [{ path: file.path, content: text, encoding: 'utf8' }], [], note, [], ifVersion);
  }

  /**
   * Splits text out of one file into new files on the server, so turning a
   * single large page into separate HTML, CSS, JS and data files costs a few
   * markers instead of retyping every byte. For each extraction, the text
   * strictly between `start` and the first `end` after it becomes the file
   * `to`, and the whole span, markers included, is replaced by `replace_with`
   * (typically a <link> or <script src>). All extractions and the rewritten
   * source land in one version; if any fails, nothing is published.
   */
  async extractFile(
    slug: string,
    fromPath: string,
    extractions: Extraction[],
    options: { note?: string; overwrite?: boolean; ifVersion?: string } = {},
  ): Promise<PublishResult & { extracted: { path: string; bytes: number }[] }> {
    if (extractions.length === 0) throw new UserError('Pass at least one extraction.');
    const site = await this.requireSite(slug);
    const file = await this.readSiteFile(slug, fromPath, undefined, Infinity);
    if (!isTextType(file.contentType)) {
      throw new UserError(`${file.path} is ${file.contentType}, not text, so it cannot be split.`);
    }
    const existing = new Set((await this.listFiles(site.current_version_id!)).map(f => f.path));
    const targets = new Set<string>();
    let text = decodeUtf8(file.data);
    const out: InputFile[] = [];

    extractions.forEach((x, i) => {
      const label = extractions.length > 1 ? `Extraction ${i + 1}: ` : '';
      const to = normalizeSitePath(x.to);
      if (to === file.path) throw new UserError(`${label}"to" must differ from the source file.`);
      if (targets.has(to)) throw new UserError(`${label}${to} is extracted to twice in one call.`);
      if (existing.has(to) && !options.overwrite) {
        throw new UserError(`${label}${to} already exists. Pass overwrite:true to replace it. Nothing was changed.`);
      }
      if (x.start === '' || x.end === '') throw new UserError(`${label}start and end must not be empty.`);
      const count = text.split(x.start).length - 1;
      if (count !== 1) {
        throw new UserError(
          count === 0
            ? `${label}start was not found in ${file.path}. It must match exactly, whitespace included — re-read it with site_read_file. Nothing was changed.`
            : `${label}start occurs ${count} times in ${file.path}. Include more surrounding text so it is unique. Nothing was changed.`,
        );
      }
      const from = text.indexOf(x.start);
      const bodyStart = from + x.start.length;
      const bodyEnd = text.indexOf(x.end, bodyStart);
      if (bodyEnd === -1) {
        throw new UserError(`${label}end was not found after start in ${file.path}. Nothing was changed.`);
      }
      targets.add(to);
      out.push({ path: to, content: text.slice(bodyStart, bodyEnd), encoding: 'utf8' });
      text = text.slice(0, from) + x.replace_with + text.slice(bodyEnd + x.end.length);
    });

    const result = await this.updateFiles(
      slug,
      [{ path: file.path, content: text, encoding: 'utf8' }, ...out],
      [],
      options.note,
      [],
      options.ifVersion,
    );
    return {
      ...result,
      extracted: out.map(f => ({ path: f.path, bytes: new TextEncoder().encode(f.content).byteLength })),
    };
  }

  // ---------------------------------------------------------------- staging

  /**
   * Writes a file, or appends a chunk to one, in the slug's staging area. Staged
   * files are never served; they wait for site_publish or site_update_files to
   * name them. This exists because agents cap the size of a single tool call
   * far below the per-file limit, so a large page has to arrive in pieces.
   */
  async stageFile(slug: string, input: InputFile, append: boolean) {
    const s = slug.trim().toLowerCase();
    if (!isValidSlug(s)) throw new UserError(`Invalid slug "${slug}".`);
    const path = normalizeSitePath(input.path);
    const encoding = input.encoding ?? 'utf8';
    if (encoding === 'base64' && input.content.replace(/\s/g, '').length % 4 !== 0) {
      // atob tolerates missing padding, so a chunk split mid-quantum would
      // silently lose bits instead of failing.
      throw new UserError('Each base64 chunk must be a multiple of 4 characters long — split on a 4-character boundary.');
    }
    const chunk = decode(input.content, encoding, path);
    let data = chunk;
    if (append) {
      const previous = await this.blobs.get(stagingKey(s, path));
      if (!previous) {
        throw new UserError(`Nothing is staged at ${path} for "${s}" yet — send the first chunk with append:false.`);
      }
      const head = new Uint8Array(await previous.arrayBuffer());
      data = new Uint8Array(head.byteLength + chunk.byteLength);
      data.set(head);
      data.set(chunk, head.byteLength);
    }
    if (data.byteLength > this.config.maxFileBytes) {
      throw new UserError(
        `${path} would be ${data.byteLength} bytes, over the ${this.config.maxFileBytes} byte per-file limit.`,
      );
    }
    await this.blobs.put(stagingKey(s, path), data as never);
    return { slug: s, path, bytes: data.byteLength, staged: await this.listStaged(s) };
  }

  async listStaged(slug: string): Promise<{ path: string; bytes: number }[]> {
    const prefix = stagingPrefix(slug);
    const page = await this.blobs.list({ prefix, limit: 1000 });
    return page.objects.map(o => ({ path: o.key.slice(prefix.length), bytes: o.size }));
  }

  private async loadStaged(slug: string, paths: string[]): Promise<InputFile[]> {
    const files: InputFile[] = [];
    for (const raw of paths) {
      const path = normalizeSitePath(raw);
      const object = await this.blobs.get(stagingKey(slug, path));
      if (!object) {
        throw new UserError(`${path} is not staged for "${slug}". Send it with site_stage_file first.`);
      }
      files.push({ path, content: encodeBase64(new Uint8Array(await object.arrayBuffer())), encoding: 'base64' });
    }
    return files;
  }

  private async clearStaged(slug: string, paths: string[]): Promise<void> {
    await this.blobs.delete(paths.map(p => stagingKey(slug, p)) as never).catch(() => {});
  }

  /**
   * Copies one carried file into the new version by streaming it between
   * objects. A missing source used to be skipped, so the update reported
   * success with the file gone; now it stops the publish.
   */
  private async copyObject(file: CarriedFile, toKey: string): Promise<void> {
    const source = await this.blobs.get(file.fromKey);
    if (!source) {
      throw new UserError(
        `${file.path} is part of the current version but its stored copy is missing, so carrying it ` +
          'over would silently drop it. Nothing was published. Re-upload it in this update, or restore ' +
          'an earlier version with site_rollback.',
        409,
      );
    }
    // R2 needs a length-known stream; FixedLengthStream supplies one without buffering.
    const { readable, writable } = new FixedLengthStream(source.size);
    await Promise.all([
      source.body.pipeTo(writable as never),
      this.blobs.put(toKey, readable as never, { httpMetadata: { contentType: file.contentType } }),
    ]);
  }

  /** The file-count and total-size limits, over new and carried files together. */
  private checkTotals(files: StoredFile[]): void {
    if (files.length > this.config.maxFiles) {
      throw new UserError(
        `Too many files: ${files.length} (limit ${this.config.maxFiles}). Split the site or raise A2W_MAX_FILES.`,
      );
    }
    const total = files.reduce((n, f) => n + f.bytes, 0);
    if (total > this.config.maxSiteBytes) {
      throw new UserError(
        `Site exceeds the ${this.config.maxSiteBytes} byte total limit. Remove files or raise A2W_MAX_SITE_BYTES.`,
      );
    }
  }

  private async commitVersion(
    site: SiteRow,
    versionId: string,
    files: StoredFile[],
    options: PublishOptions,
    now: number,
  ): Promise<void> {
    const bytes = files.reduce((n, f) => n + f.bytes, 0);
    const statements: Statement[] = [
      stmt(
        `INSERT INTO versions (id, site_id, note, bytes, file_count, created_at, actor, actor_label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        versionId,
        site.id,
        options.note ?? '',
        bytes,
        files.length,
        now,
        this.actor?.id ?? null,
        this.actor?.label?.slice(0, 80) ?? null,
      ),
    ];
    for (const file of files) {
      statements.push(
        stmt(
          `INSERT INTO files (version_id, path, bytes, content_type, sha256) VALUES (?, ?, ?, ?, ?)`,
          versionId,
          file.path,
          file.bytes,
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
    if (options.ifVersion === undefined) {
      statements.push(stmt(`UPDATE sites SET ${sets.join(', ')} WHERE id = ?`, ...params));
      await this.sql.batch(statements);
      return;
    }

    // Compare-and-swap. The pointer moves first, and only if it still points
    // at if_version; every insert after it is conditional on that move having
    // happened. D1 runs a batch as one transaction, so a concurrent write that
    // got in first makes this whole batch a no-op rather than a second winner.
    const moved = `EXISTS (SELECT 1 FROM sites WHERE id = ? AND current_version_id = ?)`;
    const guarded = statements.map(s => ({
      sql: s.sql.replace(/VALUES \(([^)]*)\)\s*$/, `SELECT $1 WHERE ${moved}`),
      params: [...(s.params ?? []), site.id, versionId],
    }));
    const changes = await this.sql.batch([
      stmt(`UPDATE sites SET ${sets.join(', ')} WHERE id = ? AND current_version_id = ?`, ...params, options.ifVersion),
      ...guarded,
    ]);
    if (changes[0] !== 1) {
      throw await this.versionConflict((await this.getSiteById(site.id))!, options.ifVersion);
    }
  }

  /** The 409 for a write based on a version that is no longer live. */
  private async versionConflict(site: SiteRow, expected: string): Promise<UserError> {
    const live = site.current_version_id ? await this.getVersion(site.id, site.current_version_id) : undefined;
    const who = live?.actor ? ` by ${live.actor_label ? `${live.actor_label} (${live.actor})` : live.actor}` : '';
    const when = live ? ` at ${new Date(live.created_at).toISOString()}` : '';
    return new UserError(
      `"${site.slug}" has moved on: the live version is ${site.current_version_id ?? 'none'}, created${who}${when}, ` +
        `not ${expected}. Nothing was published. Re-read the site, re-apply your change on top of the live ` +
        `version, and retry with if_version:"${site.current_version_id}".`,
      409,
    );
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
    await this.deleteByPrefix(stagingPrefix(site.slug));
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

/** Staged uploads older than this are abandoned: nothing is going to publish them. */
export const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes staged uploads nobody published. site_stage_file writes outside
 * sites/, so neither pruning nor site deletion ever reaches a file that was
 * staged and then forgotten. Returns how many objects were removed.
 */
export async function purgeStaging(
  blobs: R2Bucket,
  now = Date.now(),
  maxAgeMs = STAGING_MAX_AGE_MS,
): Promise<number> {
  let removed = 0;
  let cursor: string | undefined;
  do {
    const page = await blobs.list({ prefix: 'staging/', cursor, limit: 1000 });
    const stale = page.objects.filter(o => now - o.uploaded.getTime() > maxAgeMs).map(o => o.key);
    if (stale.length) await blobs.delete(stale as never);
    removed += stale.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return removed;
}

export function isTextType(contentType: string): boolean {
  return (
    contentType.startsWith('text/') ||
    contentType.startsWith('application/json') ||
    contentType.startsWith('image/svg')
  );
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
