-- agent2web schema. Applied in full on an empty database; future changes go in
-- numbered migration blocks in db.ts keyed off PRAGMA user_version.

CREATE TABLE IF NOT EXISTS sites (
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
);

CREATE TABLE IF NOT EXISTS versions (
  id         TEXT PRIMARY KEY,
  site_id    TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  note       TEXT NOT NULL DEFAULT '',
  bytes      INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS versions_site_created ON versions(site_id, created_at DESC);

CREATE TABLE IF NOT EXISTS files (
  version_id   TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  PRIMARY KEY (version_id, path)
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id                TEXT PRIMARY KEY,
  client_secret_hash       TEXT,
  client_id_issued_at      INTEGER NOT NULL,
  client_secret_expires_at INTEGER,
  metadata                 TEXT NOT NULL,
  created_at               INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_auth_requests (
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
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes         TEXT NOT NULL DEFAULT '',
  resource       TEXT,
  used           INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash  TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  client_id   TEXT NOT NULL,
  scopes      TEXT NOT NULL DEFAULT '',
  resource    TEXT,
  chain_id    TEXT NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_tokens_client ON oauth_tokens(client_id);
CREATE INDEX IF NOT EXISTS oauth_tokens_chain ON oauth_tokens(chain_id);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id_hash    TEXT PRIMARY KEY,
  label      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
