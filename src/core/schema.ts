import type { Sql } from '../d1.js';
import { newId } from '../util/ids.js';

/**
 * The schema, as ordered migrations of individual statements.
 *
 * This used to be a schema.sql read from disk and versioned with
 * `PRAGMA user_version`. Neither survives on Cloudflare: a Worker has no
 * filesystem, and D1 does not expose pragmas. Statements are listed one per
 * entry because D1 applies them through prepared statements rather than a
 * multi-statement exec.
 *
 * Append new migrations; never edit an existing one.
 */
export const MIGRATIONS: string[][] = [
  // 1 — initial schema
  [
    `CREATE TABLE IF NOT EXISTS sites (
       id                 TEXT PRIMARY KEY,
       slug               TEXT NOT NULL UNIQUE,
       title              TEXT NOT NULL DEFAULT '',
       custom_domain      TEXT UNIQUE,
       visibility         TEXT NOT NULL DEFAULT 'public'
                          CHECK (visibility IN ('public', 'password', 'disabled')),
       password_hash      TEXT,
       current_version_id TEXT,
       view_count         INTEGER NOT NULL DEFAULT 0,
       created_at         INTEGER NOT NULL,
       updated_at         INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS versions (
       id         TEXT PRIMARY KEY,
       site_id    TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
       note       TEXT NOT NULL DEFAULT '',
       bytes      INTEGER NOT NULL DEFAULT 0,
       file_count INTEGER NOT NULL DEFAULT 0,
       created_at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS versions_site_created ON versions(site_id, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS files (
       version_id   TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
       path         TEXT NOT NULL,
       bytes        INTEGER NOT NULL,
       content_type TEXT NOT NULL,
       sha256       TEXT NOT NULL,
       PRIMARY KEY (version_id, path)
     )`,
    `CREATE TABLE IF NOT EXISTS oauth_clients (
       client_id                TEXT PRIMARY KEY,
       client_secret_hash       TEXT,
       client_id_issued_at      INTEGER NOT NULL,
       client_secret_expires_at INTEGER,
       metadata                 TEXT NOT NULL,
       created_at               INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS oauth_auth_requests (
       id             TEXT PRIMARY KEY,
       client_id      TEXT NOT NULL,
       redirect_uri   TEXT NOT NULL,
       code_challenge TEXT NOT NULL,
       state          TEXT,
       scopes         TEXT NOT NULL DEFAULT '',
       resource       TEXT,
       approved       INTEGER NOT NULL DEFAULT 0,
       created_at     INTEGER NOT NULL,
       expires_at     INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS oauth_codes (
       code_hash      TEXT PRIMARY KEY,
       client_id      TEXT NOT NULL,
       redirect_uri   TEXT NOT NULL,
       code_challenge TEXT NOT NULL,
       scopes         TEXT NOT NULL DEFAULT '',
       resource       TEXT,
       used           INTEGER NOT NULL DEFAULT 0,
       created_at     INTEGER NOT NULL,
       expires_at     INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS oauth_tokens (
       token_hash  TEXT PRIMARY KEY,
       kind        TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
       client_id   TEXT NOT NULL,
       scopes      TEXT NOT NULL DEFAULT '',
       resource    TEXT,
       chain_id    TEXT NOT NULL,
       revoked     INTEGER NOT NULL DEFAULT 0,
       created_at  INTEGER NOT NULL,
       expires_at  INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS oauth_tokens_client ON oauth_tokens(client_id)`,
    `CREATE INDEX IF NOT EXISTS oauth_tokens_chain ON oauth_tokens(chain_id)`,
    `CREATE TABLE IF NOT EXISTS admin_sessions (
       id_hash    TEXT PRIMARY KEY,
       label      TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL,
       expires_at INTEGER NOT NULL
     )`,
  ],

  // 2 — credential throttling moved out of process memory, which does nothing
  //     across Cloudflare isolates
  [
    `CREATE TABLE IF NOT EXISTS login_attempts (
       key        TEXT PRIMARY KEY,
       count      INTEGER NOT NULL DEFAULT 0,
       expires_at INTEGER NOT NULL
     )`,
  ],
];

export const SCHEMA_VERSION = MIGRATIONS.length;

const META_TABLE = `CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;

/** How long a migration lock is honoured before another isolate may take it over. */
const LOCK_TTL_MS = 30_000;

export type MigrateOptions = {
  /** How long a loser waits for the lock holder to finish before giving up. */
  waitMs?: number;
  pollMs?: number;
};

/**
 * Applies any migrations this database has not seen yet, one isolate at a time.
 *
 * Cold isolates start together, and each used to run the pending migrations
 * itself. That was harmless only while every statement was CREATE ... IF NOT
 * EXISTS; SQLite has no ADD COLUMN IF NOT EXISTS, so the first ALTER TABLE would
 * fail in every isolate but the fastest. Now one isolate takes a lock row, and
 * the others wait for the schema version to catch up.
 *
 * The lock is a row holding an expiry and a random token. D1 serialises
 * writes, so the conditional upsert that takes it cannot be won twice, and an
 * isolate that died holding it only blocks others until the expiry.
 */
export async function migrate(
  db: Sql,
  migrations: string[][] = MIGRATIONS,
  options: MigrateOptions = {},
): Promise<number> {
  const target = migrations.length;
  const waitMs = options.waitMs ?? 20_000;
  const pollMs = options.pollMs ?? 200;
  await db.run(META_TABLE);
  if ((await currentVersion(db)) >= target) return target;

  const deadline = Date.now() + waitMs;
  for (;;) {
    const token = newId(16);
    const now = Date.now();
    const acquired = await db.changes(
      `INSERT INTO schema_meta (key, value) VALUES ('migration_lock', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value
         WHERE CAST(substr(schema_meta.value, 1, instr(schema_meta.value, ':') - 1) AS INTEGER) < ?`,
      `${now + LOCK_TTL_MS}:${token}`,
      now,
    );
    if (acquired === 1) {
      try {
        // Another isolate may have finished between our check and the lock.
        const from = await currentVersion(db);
        for (let version = from + 1; version <= target; version++) {
          for (const statement of migrations[version - 1]!) await db.run(statement);
          await db.run(
            `INSERT INTO schema_meta (key, value) VALUES ('version', ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            String(version),
          );
        }
        return target;
      } finally {
        await db.run(`DELETE FROM schema_meta WHERE key = 'migration_lock' AND value LIKE ?`, `%:${token}`);
      }
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
    if ((await currentVersion(db)) >= target) return target;
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for another isolate to finish migrating the database.');
    }
  }
}

async function currentVersion(db: Sql): Promise<number> {
  const row = await db.first<{ value: string }>(
    `SELECT value FROM schema_meta WHERE key = 'version'`,
  );
  if (row) return Number(row.value) || 0;

  // Databases created before schema_meta existed tracked their version in
  // PRAGMA user_version, which D1 cannot read. Those only ever reached version
  // 1, and the presence of `sites` is the reliable signal.
  const sites = await db.first<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sites'`,
  );
  return sites ? 1 : 0;
}
