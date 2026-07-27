import type { Context } from 'hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Env } from './app.js';
import { createMcpServer } from '../core/mcp/server.js';
import { PUBLISH_SCOPE } from '../oauth.js';
import { stringsEqual } from '../util/bytes.js';
import { rememberPublicUrl } from '../public-url.js';

/**
 * The MCP endpoint.
 *
 * Two credentials are accepted: the static A2W_API_TOKEN (handy for Claude Code,
 * curl and CI) and OAuth access tokens issued by this server, which is what
 * Claude's custom connectors use. Unauthenticated requests get a 401 carrying the
 * WWW-Authenticate header that points clients at our OAuth metadata (RFC 9728),
 * which is how a client discovers it needs to authenticate at all.
 */
export async function handleMcp(c: Context<Env>): Promise<Response> {
  const { config, oauth, store, crypto } = c.var;

  if (c.req.method !== 'POST') {
    return json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'This MCP server is stateless: use POST for all requests.' }, id: null },
      405,
      { Allow: 'POST' },
    );
  }

  const header = c.req.header('authorization');
  const presented = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined;
  if (!presented) {
    return unauthorized(c, 'Missing Authorization header');
  }

  let clientId: string | undefined;
  if (config.apiToken && stringsEqual(presented, config.apiToken)) {
    clientId = 'static-api-token';
  } else {
    const auth = await oauth.verifyAccessToken(presented);
    if (!auth) return unauthorized(c, 'Invalid or expired access token');
    if (!auth.scopes.includes(PUBLISH_SCOPE)) {
      return insufficientScope(c);
    }
    clientId = auth.clientId;
  }

  // Authenticated, so this origin is the owner's. Recorded once, if unset.
  c.executionCtx.waitUntil(rememberPublicUrl(c.var.sql, c.req.url));

  const server = createMcpServer({ config, store });
  // Stateless with plain JSON responses: nothing to keep between requests, and
  // a Worker has nowhere to keep it anyway.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(c.req.raw);
  } catch (err) {
    console.error('[mcp] request failed', err);
    return json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }, 500);
  } finally {
    c.executionCtx.waitUntil(
      Promise.resolve().then(async () => {
        await transport.close().catch(() => {});
        await server.close().catch(() => {});
      }),
    );
  }
}

function unauthorized(c: Context<Env>, message: string): Response {
  const { oauth } = c.var;
  return json({ error: 'invalid_token', error_description: message }, 401, {
    'WWW-Authenticate':
      `Bearer error="invalid_token", error_description="${message}", ` +
      `scope="${PUBLISH_SCOPE}", resource_metadata="${oauth.resourceMetadataUrl()}"`,
  });
}

function insufficientScope(c: Context<Env>): Response {
  const { oauth } = c.var;
  return json({ error: 'insufficient_scope', error_description: 'Insufficient scope' }, 403, {
    'WWW-Authenticate':
      `Bearer error="insufficient_scope", error_description="Insufficient scope", ` +
      `scope="${PUBLISH_SCOPE}", resource_metadata="${oauth.resourceMetadataUrl()}"`,
  });
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });
}

/** MCP clients in browsers need these; auth is by bearer token, never cookies. */
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
  'Access-Control-Max-Age': '600',
};
