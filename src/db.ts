import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;

const SCHEMA_VERSION = 1;

/**
 * Opens (creating if needed) the SQLite database and brings it up to
 * SCHEMA_VERSION. WAL mode keeps readers (page serving) from blocking on
 * writers (publishing).
 */
export function openDb(dbPath: string): Db {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = Number(
    (db.pragma('user_version', { simple: true }) as number | bigint | undefined) ?? 0,
  );
  if (current >= SCHEMA_VERSION) return;

  if (current === 0) {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
    db.exec(sql);
  }
  // Future migrations: `if (current < 2) db.exec(...)` in ascending order.

  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

export type SiteRow = {
  id: string;
  slug: string;
  title: string;
  custom_domain: string | null;
  visibility: 'public' | 'password' | 'disabled';
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

export type OAuthClientRow = {
  client_id: string;
  client_secret_hash: string | null;
  client_id_issued_at: number;
  client_secret_expires_at: number | null;
  metadata: string;
  created_at: number;
};

export type OAuthAuthRequestRow = {
  id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string | null;
  scopes: string;
  resource: string | null;
  approved: number;
  created_at: number;
  expires_at: number;
};

export type OAuthCodeRow = {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string;
  resource: string | null;
  used: number;
  created_at: number;
  expires_at: number;
};

export type OAuthTokenRow = {
  token_hash: string;
  kind: 'access' | 'refresh';
  client_id: string;
  scopes: string;
  resource: string | null;
  chain_id: string;
  revoked: number;
  created_at: number;
  expires_at: number;
};

export type AdminSessionRow = {
  id_hash: string;
  label: string;
  created_at: number;
  expires_at: number;
};

/** Deletes rows that can only ever be expired garbage. Cheap; run periodically. */
export function purgeExpired(db: Db, now = Date.now()): void {
  db.prepare('DELETE FROM oauth_auth_requests WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(now - 60_000);
  db.prepare('DELETE FROM oauth_tokens WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(now);
}
