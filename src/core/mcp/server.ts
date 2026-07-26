import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSiteTools, type ToolContext } from './tools.js';

export const SERVER_NAME = 'agent2web';
export const SERVER_VERSION = '0.1.0';

/**
 * Builds a fresh MCP server. The HTTP layer is stateless — one server and one
 * transport per request — so nothing is shared between calls.
 */
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        'agent2web hosts static websites. Use site_publish to put HTML online and get a URL back;',
        'pass the same slug again (or use site_update_files) to iterate on a site without changing its URL.',
        'Sites can be public, password protected or disabled — see site_set_access.',
      ].join(' '),
      capabilities: { tools: {} },
    },
  );
  registerSiteTools(server, ctx);
  return server;
}
