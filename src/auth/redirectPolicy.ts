import type { Config } from '../config.js';

/** Hosts whose callback endpoints belong to Claude's hosted surfaces. */
const CLAUDE_HOSTS = new Set(['claude.ai', 'claude.com', 'www.claude.ai', 'www.claude.com']);

/**
 * Dynamic client registration is open by design (Claude registers itself), so
 * the redirect URI is what limits where an authorization code can ever land.
 *
 * Allowed: any https URL on Claude's own hosts, loopback URLs on any port (how
 * Claude Code and the MCP Inspector receive the callback), and anything the
 * operator listed in A2W_EXTRA_REDIRECT_URIS.
 */
export function isAllowedRedirectUri(config: Config, candidate: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;

  if (config.extraRedirectUris.includes(candidate)) return true;

  if (url.protocol === 'https:' && CLAUDE_HOSTS.has(url.hostname.toLowerCase())) return true;

  if (url.protocol === 'http:' && isLoopback(url.hostname)) return true;

  // Deliberately not allowing this app's own origin: authorization codes would
  // then be delivered into a URL served by a published page. Operators who want
  // that can list the exact URI in A2W_EXTRA_REDIRECT_URIS.
  return false;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

export function redirectPolicyHelp(config: Config): string {
  const extras = config.extraRedirectUris.length
    ? ` Additionally allowed: ${config.extraRedirectUris.join(', ')}.`
    : '';
  return (
    'redirect_uris must be https URLs on claude.ai / claude.com, or http loopback URLs ' +
    `(http://127.0.0.1:<port>/…, http://localhost:<port>/…).${extras} ` +
    'Set A2W_EXTRA_REDIRECT_URIS to allow other exact URIs.'
  );
}
