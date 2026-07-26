import { Hono } from 'hono';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { Config } from '../core/config.js';
import type { CryptoPort } from '../ports/crypto.js';
import type { AdminSessionRow } from '../core/session.js';
import { Sql } from '../d1.js';
import { SiteStore } from '../store.js';
import { OAuthServer } from '../oauth.js';
import { Throttle } from '../core/throttle.js';
import { resolveRequest } from '../core/resolve.js';
import { notFoundPage, messagePage } from '../core/views/pages.js';
import { isUserError } from '../util/errors.js';
import { esc } from '../util/html.js';
import { adminRoutes } from './admin.js';
import { oauthRoutes } from './oauth.js';
import { handleMcp, CORS_HEADERS } from './mcp.js';
import { html, serveSite } from './hosting.js';

export type Bindings = {
  DB: D1Database;
  BLOBS: R2Bucket;
  [key: string]: unknown;
};

export type Variables = {
  config: Config;
  crypto: CryptoPort;
  sql: Sql;
  store: SiteStore;
  oauth: OAuthServer;
  throttles: { admin: Throttle; site: Throttle };
  session?: { id: string; row: AdminSessionRow };
};

export type Env = { Bindings: Bindings; Variables: Variables };

export type AppDeps = {
  config: Config;
  crypto: CryptoPort;
  db: D1Database;
  blobs: R2Bucket;
};

export function createApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();
  const sql = new Sql(deps.db);
  const store = new SiteStore(deps.db, deps.blobs, deps.config, deps.crypto);
  const oauth = new OAuthServer(sql, deps.config, deps.crypto);
  const throttles = {
    admin: new Throttle(sql, 8, 10 * 60_000, 'admin'),
    site: new Throttle(sql, 10, 10 * 60_000, 'site'),
  };

  app.use('*', async (c, next) => {
    c.set('config', deps.config);
    c.set('crypto', deps.crypto);
    c.set('sql', sql);
    c.set('store', store);
    c.set('oauth', oauth);
    c.set('throttles', throttles);
    return next();
  });

  /**
   * Published sites are matched before anything else, so a request arriving on a
   * site's own hostname can never reach /admin, /mcp or the OAuth endpoints.
   */
  app.use('*', async (c, next) => {
    const url = new URL(c.req.url);
    const resolution = await resolveRequest(
      deps.config,
      store,
      url.hostname,
      url.pathname + url.search,
    );
    switch (resolution.kind) {
      case 'site':
        return serveSite(c, resolution);
      case 'redirect':
        return c.redirect(resolution.location, 301);
      case 'unknown-site':
        return html(
          notFoundPage(
            resolution.slug
              ? `There is no site called "${resolution.slug}" on this server.`
              : 'No site is configured for this hostname.',
          ),
          404,
        );
      default:
        return next();
    }
  });

  app.get('/healthz', async c =>
    c.json({ status: 'ok', sites: await store.countSites(), version: '0.1.0' }),
  );

  app.route('/', oauthRoutes());

  app.all('/mcp', handleMcp);
  app.options('/mcp', c => c.body(null, 204, CORS_HEADERS));

  app.route('/admin', adminRoutes());

  app.get('/', c =>
    html(
      messagePage(
        'agent2web',
        'Static site hosting with an MCP publishing endpoint.',
        `<p style="margin:0">MCP endpoint: <code>${esc(deps.config.mcpUrl)}</code><br>
<a href="/admin">Admin</a></p>`,
      ),
    ),
  );

  app.notFound(() => html(notFoundPage(), 404));

  app.onError((err, c) => {
    if (isUserError(err)) return c.json({ error: err.message }, err.status as 400);
    console.error('[http] unhandled error', err);
    return c.json({ error: 'Internal error' }, 500);
  });

  return app;
}
