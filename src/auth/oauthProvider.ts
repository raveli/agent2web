import type { Response } from 'express';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
  ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Config } from '../config.js';
import type { Db, OAuthAuthRequestRow, OAuthClientRow, OAuthCodeRow, OAuthTokenRow } from '../db.js';
import { keyedHash, randomToken } from './passwords.js';
import { isAllowedRedirectUri, redirectPolicyHelp } from './redirectPolicy.js';
import { newId } from '../util/ids.js';

export const PUBLISH_SCOPE = 'publish';

const AUTH_REQUEST_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 60_000;
const ACCESS_TTL_MS = 60 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 3600_000;
const MAX_CLIENTS = 200;

/**
 * Registered-clients store backed by SQLite.
 *
 * Only public clients (PKCE, no client secret) are accepted: the SDK's token
 * endpoint compares client secrets in plaintext, and storing plaintext secrets
 * for a single-owner server buys nothing. Claude's connectors and Claude Code
 * both register as public clients.
 */
export class SqliteClientsStore implements OAuthRegisteredClientsStore {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as
      | OAuthClientRow
      | undefined;
    if (!row) return undefined;
    return JSON.parse(row.metadata) as OAuthClientInformationFull;
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'> &
      Partial<Pick<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>>,
  ): OAuthClientInformationFull {
    if (client.token_endpoint_auth_method && client.token_endpoint_auth_method !== 'none') {
      throw new InvalidClientMetadataError(
        'This server only supports public clients: register with token_endpoint_auth_method "none" and use PKCE.',
      );
    }
    if (!client.redirect_uris?.length) {
      throw new InvalidClientMetadataError('At least one redirect_uri is required.');
    }
    for (const uri of client.redirect_uris) {
      if (!isAllowedRedirectUri(this.config, uri)) {
        throw new InvalidClientMetadataError(
          `redirect_uri "${uri}" is not allowed. ${redirectPolicyHelp(this.config)}`,
        );
      }
    }
    if (client.grant_types?.some(g => g !== 'authorization_code' && g !== 'refresh_token')) {
      throw new InvalidClientMetadataError(
        'Only the authorization_code and refresh_token grant types are supported.',
      );
    }

    this.pruneUnusedClients();
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get() as { n: number }).n;
    if (count >= MAX_CLIENTS) {
      throw new ServerError(
        'Too many registered OAuth clients. Revoke unused connections in the admin UI and try again.',
      );
    }

    const now = Date.now();
    const info: OAuthClientInformationFull = {
      ...client,
      client_id: client.client_id ?? newId(24),
      client_id_issued_at: client.client_id_issued_at ?? Math.floor(now / 1000),
      token_endpoint_auth_method: 'none',
      client_secret: undefined,
      client_secret_expires_at: undefined,
    } as OAuthClientInformationFull;

    this.db
      .prepare(
        `INSERT INTO oauth_clients (client_id, client_secret_hash, client_id_issued_at, client_secret_expires_at, metadata, created_at)
         VALUES (?, NULL, ?, NULL, ?, ?)`,
      )
      .run(info.client_id, info.client_id_issued_at, JSON.stringify(info), now);
    return info;
  }

  /** Clients that never completed a flow are abandoned registrations; drop them. */
  private pruneUnusedClients(now = Date.now()): void {
    this.db
      .prepare(
        `DELETE FROM oauth_clients
          WHERE created_at < ?
            AND client_id NOT IN (SELECT client_id FROM oauth_tokens)
            AND client_id NOT IN (SELECT client_id FROM oauth_codes)`,
      )
      .run(now - 7 * 24 * 3600_000);
  }
}

export type PendingAuthorization = OAuthAuthRequestRow & { client_name: string };

/**
 * The OAuth 2.1 authorization server for this app.
 *
 * `authorize()` does not mint a code directly: it parks the request and sends the
 * browser to the owner login + consent page (see oauthPages.ts), which calls
 * `approve()` once the owner has proven who they are.
 */
export class A2WOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: SqliteClientsStore;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {
    this.clientsStore = new SqliteClientsStore(db, config);
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    this.assertResource(params.resource);
    const id = randomToken(24);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO oauth_auth_requests (id, client_id, redirect_uri, code_challenge, state, scopes, resource, approved, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        id,
        client.client_id,
        params.redirectUri,
        params.codeChallenge,
        params.state ?? null,
        PUBLISH_SCOPE,
        params.resource?.href ?? null,
        now,
        now + AUTH_REQUEST_TTL_MS,
      );
    res.redirect(302, `/oauth/consent?rid=${encodeURIComponent(id)}`);
  }

  // ------------------------------------------------- consent page callbacks

  getPendingAuthorization(id: string): PendingAuthorization | undefined {
    const row = this.db.prepare('SELECT * FROM oauth_auth_requests WHERE id = ?').get(id) as
      | OAuthAuthRequestRow
      | undefined;
    if (!row || row.expires_at < Date.now()) return undefined;
    const client = this.clientsStore.getClient(row.client_id);
    return { ...row, client_name: client?.client_name ?? row.client_id };
  }

  /** Issues an authorization code for an approved request and returns where to send the browser. */
  approve(id: string): string {
    const pending = this.getPendingAuthorization(id);
    if (!pending) throw new InvalidGrantError('This authorization request has expired. Start again from the client.');
    const code = randomToken(32);
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM oauth_auth_requests WHERE id = ?').run(id);
      this.db
        .prepare(
          `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scopes, resource, used, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          this.hash(code),
          pending.client_id,
          pending.redirect_uri,
          pending.code_challenge,
          pending.scopes,
          pending.resource,
          now,
          now + CODE_TTL_MS,
        );
    });
    tx();
    const target = new URL(pending.redirect_uri);
    target.searchParams.set('code', code);
    if (pending.state) target.searchParams.set('state', pending.state);
    return target.href;
  }

  deny(id: string): string {
    const pending = this.getPendingAuthorization(id);
    if (!pending) return `${this.config.publicUrl}/oauth/expired`;
    this.db.prepare('DELETE FROM oauth_auth_requests WHERE id = ?').run(id);
    const target = new URL(pending.redirect_uri);
    target.searchParams.set('error', 'access_denied');
    target.searchParams.set('error_description', 'The owner denied this request.');
    if (pending.state) target.searchParams.set('state', pending.state);
    return target.href;
  }

  // --------------------------------------------------------- token exchange

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const row = this.codeRow(authorizationCode);
    if (!row || row.client_id !== client.client_id) {
      throw new InvalidGrantError('Unknown or expired authorization code.');
    }
    return row.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const row = this.codeRow(authorizationCode);
    if (!row || row.client_id !== client.client_id) {
      throw new InvalidGrantError('Unknown or expired authorization code.');
    }
    if (row.used) {
      // Replay: burn every token minted from this code.
      this.db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE chain_id = ?').run(row.code_hash);
      throw new InvalidGrantError('This authorization code has already been used.');
    }
    if (redirectUri !== undefined && redirectUri !== row.redirect_uri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request.');
    }
    if (resource !== undefined) {
      this.assertResource(resource);
      if (row.resource && normalizeResource(row.resource) !== normalizeResource(resource.href)) {
        throw new InvalidTargetError('resource does not match the authorization request.');
      }
    }
    this.db.prepare('UPDATE oauth_codes SET used = 1 WHERE code_hash = ?').run(row.code_hash);
    return this.issueTokens(client.client_id, row.code_hash, resource?.href ?? row.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const row = this.tokenRow(refreshToken);
    if (!row || row.kind !== 'refresh' || row.client_id !== client.client_id) {
      throw new InvalidGrantError('Unknown refresh token.');
    }
    if (row.revoked) {
      // A revoked refresh token being presented means it leaked — kill the chain.
      this.db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE chain_id = ?').run(row.chain_id);
      throw new InvalidGrantError('This refresh token was already used. Re-authorize the connection.');
    }
    if (row.expires_at < Date.now()) {
      throw new InvalidGrantError('Refresh token has expired. Re-authorize the connection.');
    }
    if (resource !== undefined) this.assertResource(resource);
    this.db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ?').run(row.token_hash);
    return this.issueTokens(client.client_id, row.chain_id, resource?.href ?? row.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = this.tokenRow(token);
    if (!row || row.kind !== 'access') throw new InvalidTokenError('Unknown access token.');
    if (row.revoked) throw new InvalidTokenError('This access token has been revoked.');
    if (row.expires_at < Date.now()) throw new InvalidTokenError('Access token has expired.');
    if (row.resource && normalizeResource(row.resource) !== normalizeResource(this.config.mcpUrl)) {
      throw new InvalidTokenError('This token was issued for a different resource.');
    }
    return {
      token,
      clientId: row.client_id,
      scopes: row.scopes ? row.scopes.split(' ') : [],
      expiresAt: Math.floor(row.expires_at / 1000),
      resource: new URL(this.config.mcpUrl),
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const row = this.tokenRow(request.token);
    if (!row || row.client_id !== client.client_id) return;
    this.db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ?').run(row.token_hash);
  }

  // -------------------------------------------------------------- internals

  private issueTokens(clientId: string, chainId: string, resource?: string | null): OAuthTokens {
    const accessToken = randomToken(32);
    const refreshToken = randomToken(32);
    const now = Date.now();
    const insert = this.db.prepare(
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, scopes, resource, chain_id, revoked, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      insert.run(
        this.hash(accessToken),
        'access',
        clientId,
        PUBLISH_SCOPE,
        resource ?? null,
        chainId,
        now,
        now + ACCESS_TTL_MS,
      );
      insert.run(
        this.hash(refreshToken),
        'refresh',
        clientId,
        PUBLISH_SCOPE,
        resource ?? null,
        chainId,
        now,
        now + REFRESH_TTL_MS,
      );
    });
    tx();
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      scope: PUBLISH_SCOPE,
      refresh_token: refreshToken,
    };
  }

  private assertResource(resource: URL | undefined): void {
    if (!resource) return;
    if (normalizeResource(resource.href) !== normalizeResource(this.config.mcpUrl)) {
      throw new InvalidTargetError(
        `This server only issues tokens for ${this.config.mcpUrl} (got ${resource.href}).`,
      );
    }
  }

  private codeRow(code: string): OAuthCodeRow | undefined {
    const row = this.db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(this.hash(code)) as
      | OAuthCodeRow
      | undefined;
    if (!row) return undefined;
    if (row.expires_at < Date.now() && !row.used) return undefined;
    return row;
  }

  private tokenRow(token: string): OAuthTokenRow | undefined {
    return this.db.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ?').get(this.hash(token)) as
      | OAuthTokenRow
      | undefined;
  }

  private hash(value: string): string {
    return keyedHash(this.config.secret, value);
  }
}

/** Compares resource identifiers ignoring a trailing slash and any fragment. */
function normalizeResource(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href.replace(/\/$/, '');
  } catch {
    return value.replace(/\/$/, '');
  }
}
