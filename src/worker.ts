import type { ExecutionContext } from '@cloudflare/workers-types';
import { WebCryptoProvider } from './core/crypto.js';
import { ConfigError, loadConfig, type Config } from './core/config.js';
import { migrate } from './core/schema.js';
import { purgeOAuth } from './oauth.js';
import { purgeAttempts } from './core/throttle.js';
import { Sql } from './d1.js';
import { createApp, type Bindings } from './http/app.js';
import { readPublicUrl } from './public-url.js';

/**
 * The Worker entry point.
 *
 * Config parsing, migration and app construction are memoised per isolate: they
 * are pure functions of the bindings, and an isolate serves many requests. A
 * configuration error is returned as a 500 with the reason rather than thrown
 * into a stack trace, since there is no console to read on a deployed Worker.
 */
let cached: { app: ReturnType<typeof createApp>; config: Config } | undefined;
let migrated: Promise<unknown> | undefined;
let configError: string | undefined;
let warnedUnsettled = false;

const crypto = new WebCryptoProvider();

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    if (configError) return plain(configError, 500);

    const sql = new Sql(env.DB);
    // Migrations run once per isolate, and are idempotent besides. They come
    // first because the public URL may need to be read from the database.
    migrated ??= migrate(sql);
    await migrated;

    let publicUrl: string;
    try {
      const resolved = await readPublicUrl(sql, env.A2W_PUBLIC_URL as string | undefined, request);
      publicUrl = resolved.url;
      if (!resolved.settled && !warnedUnsettled) {
        warnedUnsettled = true;
        console.warn(
          '[config] A2W_PUBLIC_URL is not set and no origin has been recorded yet. ' +
            'Using this request\'s origin provisionally; it is recorded the first time ' +
            'someone signs in to /admin or calls /mcp with a valid token.',
        );
      }
    } catch (err) {
      console.error('[boot] could not determine the public URL', err);
      return plain('Failed to start: see the Worker logs.', 500);
    }

    if (!cached || cached.config.publicUrl !== publicUrl) {
      try {
        const config = await loadConfig(
          { ...(env as Record<string, string | undefined>), A2W_PUBLIC_URL: publicUrl },
          crypto,
        );
        for (const warning of config.warnings) console.warn(`[config] ${warning}`);
        cached = { app: createApp({ config, crypto, db: env.DB, blobs: env.BLOBS }), config };
      } catch (err) {
        configError =
          err instanceof ConfigError
            ? `${err.message}\n\nSet these as secrets or vars on the Worker, then redeploy.`
            : 'Failed to start: see the Worker logs.';
        if (!(err instanceof ConfigError)) console.error('[boot]', err);
        return plain(configError, 500);
      }
    }

    return cached.app.fetch(request, env, ctx as never);
  },

  /** Wired to a cron trigger; expired rows are only ever garbage. */
  async scheduled(_event: unknown, env: Bindings, ctx: ExecutionContext): Promise<void> {
    const sql = new Sql(env.DB);
    ctx.waitUntil(
      (async () => {
        await migrate(sql);
        await purgeOAuth(sql);
        await purgeAttempts(sql);
      })(),
    );
  },
};


function plain(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
