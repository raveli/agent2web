import type { Sql } from './d1.js';

const KEY = 'public_url';

/**
 * The origin this deployment answers on.
 *
 * Nobody can know their Worker's URL before deploying it, so requiring it up
 * front made the setup form ask a question with no answer. Instead the Worker
 * learns it — but only from a request that proves it came from the owner.
 *
 * Learning from *any* request would be a trust-on-first-use hole. The value is
 * the OAuth issuer and the audience of every token, and it is also how the
 * router tells a request to the app from a request to a published site on its
 * own hostname. An attacker who landed the first request with a Host of their
 * choosing would move the issuer to their domain and, because every real
 * hostname would then look like an unknown site, 404 the whole instance
 * permanently. The same accident happens innocently if the first request arrives
 * on a Cloudflare preview URL.
 *
 * So: an explicit A2W_PUBLIC_URL always wins; otherwise a stored value; otherwise
 * the current request's origin is used for this request only, and nothing is
 * written until someone authenticates as the owner.
 */
export async function readPublicUrl(
  sql: Sql,
  explicit: string | undefined,
  request: Request,
): Promise<{ url: string; settled: boolean }> {
  const configured = explicit?.trim();
  if (configured) return { url: stripSlash(configured), settled: true };

  const stored = await sql.first<{ value: string }>(
    'SELECT value FROM schema_meta WHERE key = ?',
    KEY,
  );
  if (stored?.value) return { url: stored.value, settled: true };

  // Provisional: serves this request, teaches the deployment nothing.
  return { url: new URL(request.url).origin, settled: false };
}

/**
 * Records the origin the owner actually reached the app on. Called after an
 * admin sign-in or an authenticated MCP call, never from an anonymous request.
 * First writer wins, so a later request on some other hostname cannot move it.
 */
export async function rememberPublicUrl(sql: Sql, requestUrl: string): Promise<void> {
  const origin = new URL(requestUrl).origin;
  if (!isPlausibleOrigin(origin)) return;
  await sql.run(
    `INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`,
    KEY,
    origin,
  );
}

/**
 * A deployed instance is reached over https. http is allowed only on loopback,
 * which is `wrangler dev` and the test harness.
 */
function isPlausibleOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

const stripSlash = (value: string) => value.replace(/\/+$/, '');
