import type { ExecutionContext } from '@cloudflare/workers-types';
import { WebCryptoProvider } from './core/crypto.js';
import { ConfigError, loadConfig, type Config } from './core/config.js';
import { migrate } from './core/schema.js';
import { purgeOAuth } from './oauth.js';
import { purgeAttempts } from './core/throttle.js';
import { Sql } from './d1.js';
import { createApp, type Bindings } from './http/app.js';

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

const crypto = new WebCryptoProvider();

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    if (configError) return plain(configError, 500);

    if (!cached) {
      try {
        const config = await loadConfig(env as Record<string, string | undefined>, crypto);
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

    // Migrations run once per isolate, and are idempotent besides.
    migrated ??= migrate(new Sql(env.DB));
    await migrated;

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
