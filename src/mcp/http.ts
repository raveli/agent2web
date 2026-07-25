import express, { type Request, type RequestHandler, type Response, Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { Config } from '../config.js';
import { secretEquals } from '../auth/passwords.js';
import { createMcpServer } from './server.js';
import type { ToolContext } from './tools.js';

export const PUBLISH_SCOPE = 'publish';

/**
 * Mounts the MCP endpoint.
 *
 * Two credentials are accepted: the static `A2W_API_TOKEN` (handy for Claude
 * Code, curl and CI) and OAuth access tokens issued by this server (what Claude
 * web's custom connectors use). Unauthenticated requests get a 401 carrying the
 * `WWW-Authenticate` header that points clients at our OAuth metadata.
 */
export function createMcpRouter(
  config: Config,
  ctx: ToolContext,
  verifier: OAuthTokenVerifier,
): Router {
  const router = Router();
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(config.mcpUrl));
  const oauthGuard = requireBearerAuth({
    verifier,
    requiredScopes: [PUBLISH_SCOPE],
    resourceMetadataUrl,
  });

  const authenticate: RequestHandler = (req, res, next) => {
    const header = req.headers.authorization;
    if (config.apiToken && header?.toLowerCase().startsWith('bearer ')) {
      const presented = header.slice(7).trim();
      if (secretEquals(presented, config.apiToken)) {
        req.auth = {
          token: presented,
          clientId: 'static-api-token',
          scopes: [PUBLISH_SCOPE],
          resource: new URL(config.mcpUrl),
        };
        next();
        return;
      }
    }
    oauthGuard(req, res, next);
  };

  router.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
    );
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, WWW-Authenticate');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  router.post('/', authenticate, express.json({ limit: '64mb' }), async (req, res) => {
    const server = createMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] request failed', err);
      if (!res.headersSent) {
        res.status(500).json(rpcError(-32603, 'Internal server error'));
      }
    }
  });

  // Stateless mode has no server-initiated stream and no session to delete.
  const methodNotAllowed = (_req: Request, res: Response) => {
    res
      .status(405)
      .setHeader('Allow', 'POST')
      .json(rpcError(-32000, 'This MCP server is stateless: use POST for all requests.'));
  };
  router.get('/', methodNotAllowed);
  router.delete('/', methodNotAllowed);

  return router;
}

function rpcError(code: number, message: string) {
  return { jsonrpc: '2.0' as const, error: { code, message }, id: null };
}
