import type { Config } from './core/config.js';
import type { CryptoPort } from './ports/crypto.js';
import { Sql, stmt } from './d1.js';
import { isAllowedRedirectUri, redirectPolicyHelp } from './core/redirectPolicy.js';
import { stringsEqual } from './util/bytes.js';
import { newId } from './util/ids.js';

export const PUBLISH_SCOPE = 'publish';

const AUTH_REQUEST_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 60_000;
const ACCESS_TTL_MS = 60 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 3600_000;
const MAX_CLIENTS = 200;

/**
 * An OAuth error, carrying enough to decide how it should reach the user.
 *
 * The authorization endpoint splits errors in two: anything wrong with
 * `client_id` or `redirect_uri` must be shown directly, because sending it onward
 * would mean trusting an unvalidated redirect. Everything after that is delivered
 * to the client as redirect parameters.
 */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly redirectTo?: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }

  toJSON() {
    return { error: this.code, error_description: this.message };
  }
}

export type ClientInfo = {
  client_id: string;
  client_id_issued_at: number;
  client_name?: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  scope?: string;
  token_endpoint_auth_method: 'none';
};

export type PendingAuthorization = {
  id: string;
  client_id: string;
  client_name: string;
  redirect_uri: string;
  code_challenge: string;
  state: string | null;
  scopes: string;
  resource: string | null;
  expires_at: number;
};

export type TokenResponse = {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
  refresh_token: string;
};

export type AuthInfo = { token: string; clientId: string; scopes: string[]; expiresAt: number };

/**
 * agent2web's OAuth 2.1 authorization server.
 *
 * Transport-agnostic on purpose: every method takes and returns plain data, and
 * the Hono routes in http/oauth.ts decide status codes and redirects. That is
 * what let this survive the move off Express without touching the logic.
 */
export class OAuthServer {
  constructor(
    private readonly sql: Sql,
    private readonly config: Config,
    private readonly crypto: CryptoPort,
  ) {}

  // ------------------------------------------------------------- discovery

  authorizationServerMetadata() {
    const base = this.config.publicUrl;
    return {
      issuer: `${base}/`,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      revocation_endpoint: `${base}/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [PUBLISH_SCOPE],
    };
  }

  protectedResourceMetadata() {
    return {
      resource: this.config.mcpUrl,
      authorization_servers: [`${this.config.publicUrl}/`],
      scopes_supported: [PUBLISH_SCOPE],
      resource_name: 'agent2web',
      bearer_methods_supported: ['header'],
    };
  }

  /** The `resource_metadata` URL advertised in WWW-Authenticate (RFC 9728). */
  resourceMetadataUrl(): string {
    return `${this.config.publicUrl}/.well-known/oauth-protected-resource/mcp`;
  }

  // --------------------------------------------------- dynamic registration

  async register(body: unknown): Promise<ClientInfo> {
    const metadata = (body ?? {}) as Record<string, unknown>;
    const authMethod = metadata.token_endpoint_auth_method;
    if (authMethod !== undefined && authMethod !== 'none') {
      throw new OAuthError(
        'invalid_client_metadata',
        'This server only supports public clients: register with token_endpoint_auth_method "none" and use PKCE.',
      );
    }
    const redirectUris = metadata.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      throw new OAuthError('invalid_client_metadata', 'At least one redirect_uri is required.');
    }
    for (const uri of redirectUris) {
      if (typeof uri !== 'string' || !isAllowedRedirectUri(this.config, uri)) {
        throw new OAuthError(
          'invalid_client_metadata',
          `redirect_uri ${JSON.stringify(uri)} is not allowed. ${redirectPolicyHelp(this.config)}`,
        );
      }
    }
    const grantTypes = metadata.grant_types;
    if (
      Array.isArray(grantTypes) &&
      grantTypes.some(g => g !== 'authorization_code' && g !== 'refresh_token')
    ) {
      throw new OAuthError(
        'invalid_client_metadata',
        'Only the authorization_code and refresh_token grant types are supported.',
      );
    }

    await this.pruneUnusedClients();
    const count = await this.sql.first<{ n: number }>('SELECT COUNT(*) AS n FROM oauth_clients');
    if ((count?.n ?? 0) >= MAX_CLIENTS) {
      throw new OAuthError(
        'server_error',
        'Too many registered OAuth clients. Revoke unused connections in the admin UI and try again.',
        500,
      );
    }

    const now = Date.now();
    const info: ClientInfo = {
      client_id: newId(24),
      client_id_issued_at: Math.floor(now / 1000),
      client_name: typeof metadata.client_name === 'string' ? metadata.client_name : undefined,
      redirect_uris: redirectUris as string[],
      grant_types: (grantTypes as string[]) ?? ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: PUBLISH_SCOPE,
      token_endpoint_auth_method: 'none',
    };
    await this.sql.run(
      `INSERT INTO oauth_clients (client_id, client_secret_hash, client_id_issued_at, client_secret_expires_at, metadata, created_at)
       VALUES (?, NULL, ?, NULL, ?, ?)`,
      info.client_id,
      info.client_id_issued_at,
      JSON.stringify(info),
      now,
    );
    return info;
  }

  async getClient(clientId: string): Promise<ClientInfo | undefined> {
    const row = await this.sql.first<{ metadata: string }>(
      'SELECT metadata FROM oauth_clients WHERE client_id = ?',
      clientId,
    );
    return row ? (JSON.parse(row.metadata) as ClientInfo) : undefined;
  }

  /** Registrations that never completed a flow are abandoned; drop them. */
  private async pruneUnusedClients(now = Date.now()): Promise<void> {
    await this.sql.run(
      `DELETE FROM oauth_clients
        WHERE created_at < ?
          AND client_id NOT IN (SELECT client_id FROM oauth_tokens)
          AND client_id NOT IN (SELECT client_id FROM oauth_codes)`,
      now - 7 * 24 * 3600_000,
    );
  }

  // ------------------------------------------------------------- authorize

  /**
   * Validates an authorization request and parks it, returning the id of the
   * pending request. No code exists until the owner approves it.
   */
  async beginAuthorization(params: URLSearchParams): Promise<string> {
    const clientId = params.get('client_id');
    if (!clientId) throw new OAuthError('invalid_request', 'client_id is required.');
    const client = await this.getClient(clientId);
    if (!client) throw new OAuthError('invalid_client', 'Invalid client_id.');

    let redirectUri = params.get('redirect_uri') ?? undefined;
    if (redirectUri === undefined) {
      if (client.redirect_uris.length !== 1) {
        throw new OAuthError(
          'invalid_request',
          'redirect_uri must be specified when the client has multiple registered URIs.',
        );
      }
      redirectUri = client.redirect_uris[0]!;
    } else if (!client.redirect_uris.includes(redirectUri)) {
      throw new OAuthError('invalid_request', 'Unregistered redirect_uri.');
    }

    // Past this point the redirect_uri is trusted, so failures go to the client.
    const fail = (code: string, message: string) =>
      new OAuthError(code, message, 302, errorRedirect(redirectUri!, code, message, params.get('state')));

    if ((params.get('response_type') ?? 'code') !== 'code') {
      throw fail('unsupported_response_type', 'Only the "code" response type is supported.');
    }
    const codeChallenge = params.get('code_challenge');
    if (!codeChallenge) {
      throw fail('invalid_request', 'code_challenge is required (PKCE).');
    }
    const method = params.get('code_challenge_method') ?? 'plain';
    if (method !== 'S256') {
      throw fail('invalid_request', 'code_challenge_method must be S256.');
    }
    const resource = params.get('resource');
    if (resource && !this.sameResource(resource)) {
      throw fail(
        'invalid_target',
        `This server only issues tokens for ${this.config.mcpUrl} (got ${resource}).`,
      );
    }

    const id = this.crypto.randomToken(24);
    const now = Date.now();
    await this.sql.run(
      `INSERT INTO oauth_auth_requests (id, client_id, redirect_uri, code_challenge, state, scopes, resource, approved, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      id,
      client.client_id,
      redirectUri,
      codeChallenge,
      params.get('state'),
      PUBLISH_SCOPE,
      resource,
      now,
      now + AUTH_REQUEST_TTL_MS,
    );
    return id;
  }

  async getPending(id: string): Promise<PendingAuthorization | undefined> {
    const row = await this.sql.first<PendingAuthorization & { client_name?: string }>(
      'SELECT * FROM oauth_auth_requests WHERE id = ?',
      id,
    );
    if (!row || row.expires_at < Date.now()) return undefined;
    const client = await this.getClient(row.client_id);
    return { ...row, client_name: client?.client_name ?? row.client_id };
  }

  /** Issues a single-use code for an approved request; returns where to send the browser. */
  async approve(id: string): Promise<string> {
    const pending = await this.getPending(id);
    if (!pending) {
      throw new OAuthError(
        'invalid_grant',
        'This authorization request has expired. Start again from the client.',
      );
    }
    const code = this.crypto.randomToken(32);
    const now = Date.now();
    await this.sql.batch([
      stmt('DELETE FROM oauth_auth_requests WHERE id = ?', id),
      stmt(
        `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scopes, resource, used, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        await this.hash(code),
        pending.client_id,
        pending.redirect_uri,
        pending.code_challenge,
        pending.scopes,
        pending.resource,
        now,
        now + CODE_TTL_MS,
      ),
    ]);
    const target = new URL(pending.redirect_uri);
    target.searchParams.set('code', code);
    if (pending.state) target.searchParams.set('state', pending.state);
    return target.href;
  }

  async deny(id: string): Promise<string> {
    const pending = await this.getPending(id);
    if (!pending) return `${this.config.publicUrl}/oauth/expired`;
    await this.sql.run('DELETE FROM oauth_auth_requests WHERE id = ?', id);
    return errorRedirect(
      pending.redirect_uri,
      'access_denied',
      'The owner denied this request.',
      pending.state,
    );
  }

  // ----------------------------------------------------------------- token

  async token(form: URLSearchParams): Promise<TokenResponse> {
    const grantType = form.get('grant_type');
    const clientId = form.get('client_id');
    if (!clientId) throw new OAuthError('invalid_client', 'client_id is required.');
    const client = await this.getClient(clientId);
    if (!client) throw new OAuthError('invalid_client', 'Invalid client_id.');

    if (grantType === 'authorization_code') {
      return this.exchangeCode(client, form);
    }
    if (grantType === 'refresh_token') {
      return this.exchangeRefresh(client, form);
    }
    throw new OAuthError(
      'unsupported_grant_type',
      'The grant type is not supported by this authorization server.',
    );
  }

  private async exchangeCode(client: ClientInfo, form: URLSearchParams): Promise<TokenResponse> {
    const code = form.get('code');
    const verifier = form.get('code_verifier');
    if (!code) throw new OAuthError('invalid_request', 'code is required.');
    if (!verifier) throw new OAuthError('invalid_request', 'code_verifier is required (PKCE).');

    const hash = await this.hash(code);
    const row = await this.sql.first<{
      code_hash: string;
      client_id: string;
      redirect_uri: string;
      code_challenge: string;
      resource: string | null;
      used: number;
      expires_at: number;
    }>('SELECT * FROM oauth_codes WHERE code_hash = ?', hash);

    if (!row || row.client_id !== client.client_id) {
      throw new OAuthError('invalid_grant', 'Unknown or expired authorization code.');
    }
    if (row.used) {
      // Replay means the code leaked: burn everything minted from it. OAuth 2.1
      // asks for exactly this.
      await this.sql.run('UPDATE oauth_tokens SET revoked = 1 WHERE chain_id = ?', row.code_hash);
      throw new OAuthError('invalid_grant', 'This authorization code has already been used.');
    }
    if (row.expires_at < Date.now()) {
      throw new OAuthError('invalid_grant', 'Unknown or expired authorization code.');
    }

    const redirectUri = form.get('redirect_uri');
    if (redirectUri !== null && redirectUri !== row.redirect_uri) {
      throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request.');
    }
    if (!stringsEqual(await this.crypto.sha256Base64Url(verifier), row.code_challenge)) {
      throw new OAuthError('invalid_grant', 'code_verifier does not match the challenge.');
    }
    const resource = form.get('resource');
    if (resource) {
      if (!this.sameResource(resource)) {
        throw new OAuthError(
          'invalid_target',
          `This server only issues tokens for ${this.config.mcpUrl} (got ${resource}).`,
        );
      }
      if (row.resource && !this.sameResource(row.resource, resource)) {
        throw new OAuthError('invalid_target', 'resource does not match the authorization request.');
      }
    }

    await this.sql.run('UPDATE oauth_codes SET used = 1 WHERE code_hash = ?', hash);
    return this.issueTokens(client.client_id, row.code_hash, resource ?? row.resource);
  }

  private async exchangeRefresh(client: ClientInfo, form: URLSearchParams): Promise<TokenResponse> {
    const refreshToken = form.get('refresh_token');
    if (!refreshToken) throw new OAuthError('invalid_request', 'refresh_token is required.');
    const hash = await this.hash(refreshToken);
    const row = await this.sql.first<{
      token_hash: string;
      kind: string;
      client_id: string;
      resource: string | null;
      chain_id: string;
      revoked: number;
      expires_at: number;
    }>('SELECT * FROM oauth_tokens WHERE token_hash = ?', hash);

    if (!row || row.kind !== 'refresh' || row.client_id !== client.client_id) {
      throw new OAuthError('invalid_grant', 'Unknown refresh token.');
    }
    if (row.revoked) {
      // A spent refresh token being presented means it leaked — kill the chain.
      await this.sql.run('UPDATE oauth_tokens SET revoked = 1 WHERE chain_id = ?', row.chain_id);
      throw new OAuthError(
        'invalid_grant',
        'This refresh token was already used. Re-authorize the connection.',
      );
    }
    if (row.expires_at < Date.now()) {
      throw new OAuthError('invalid_grant', 'Refresh token has expired. Re-authorize the connection.');
    }
    const resource = form.get('resource');
    if (resource && !this.sameResource(resource)) {
      throw new OAuthError(
        'invalid_target',
        `This server only issues tokens for ${this.config.mcpUrl} (got ${resource}).`,
      );
    }

    await this.sql.run('UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ?', hash);
    return this.issueTokens(client.client_id, row.chain_id, resource ?? row.resource);
  }

  async revoke(form: URLSearchParams): Promise<void> {
    const token = form.get('token');
    const clientId = form.get('client_id');
    if (!token || !clientId) return;
    const row = await this.sql.first<{ token_hash: string; client_id: string }>(
      'SELECT token_hash, client_id FROM oauth_tokens WHERE token_hash = ?',
      await this.hash(token),
    );
    if (!row || row.client_id !== clientId) return;
    await this.sql.run('UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ?', row.token_hash);
  }

  // ------------------------------------------------------- resource server

  /** Undefined for anything the MCP endpoint should reject with a 401. */
  async verifyAccessToken(token: string): Promise<AuthInfo | undefined> {
    const row = await this.sql.first<{
      kind: string;
      client_id: string;
      scopes: string;
      resource: string | null;
      revoked: number;
      expires_at: number;
    }>('SELECT * FROM oauth_tokens WHERE token_hash = ?', await this.hash(token));

    if (!row || row.kind !== 'access') return undefined;
    if (row.revoked) return undefined;
    if (row.expires_at < Date.now()) return undefined;
    // A token minted for a different audience must not work here (RFC 8707).
    if (row.resource && !this.sameResource(row.resource)) return undefined;
    return {
      token,
      clientId: row.client_id,
      scopes: row.scopes ? row.scopes.split(' ') : [],
      expiresAt: Math.floor(row.expires_at / 1000),
    };
  }

  // -------------------------------------------------------------- internals

  private async issueTokens(
    clientId: string,
    chainId: string,
    resource?: string | null,
  ): Promise<TokenResponse> {
    const accessToken = this.crypto.randomToken(32);
    const refreshToken = this.crypto.randomToken(32);
    const now = Date.now();
    const insert = `INSERT INTO oauth_tokens (token_hash, kind, client_id, scopes, resource, chain_id, revoked, created_at, expires_at)
                    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`;
    await this.sql.batch([
      stmt(
        insert,
        await this.hash(accessToken),
        'access',
        clientId,
        PUBLISH_SCOPE,
        resource ?? null,
        chainId,
        now,
        now + ACCESS_TTL_MS,
      ),
      stmt(
        insert,
        await this.hash(refreshToken),
        'refresh',
        clientId,
        PUBLISH_SCOPE,
        resource ?? null,
        chainId,
        now,
        now + REFRESH_TTL_MS,
      ),
    ]);
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      scope: PUBLISH_SCOPE,
      refresh_token: refreshToken,
    };
  }

  private sameResource(a: string, b = this.config.mcpUrl): boolean {
    return normalizeResource(a) === normalizeResource(b);
  }

  private hash(value: string): Promise<string> {
    return this.crypto.hmac(this.config.secret, value);
  }
}

function errorRedirect(
  redirectUri: string,
  code: string,
  description: string,
  state: string | null,
): string {
  const url = new URL(redirectUri);
  url.searchParams.set('error', code);
  url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  return url.href;
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

/** Expired requests, spent codes and dead tokens are only ever garbage. */
export async function purgeOAuth(sql: Sql, now = Date.now()): Promise<void> {
  await sql.run('DELETE FROM oauth_auth_requests WHERE expires_at < ?', now);
  await sql.run('DELETE FROM oauth_codes WHERE expires_at < ?', now - 60_000);
  await sql.run('DELETE FROM oauth_tokens WHERE expires_at < ?', now);
  await sql.run('DELETE FROM admin_sessions WHERE expires_at < ?', now);
}
