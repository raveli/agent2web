import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { purgeExpired } from './db.js';
import { SiteStore } from './storage.js';
import { A2WOAuthProvider, PUBLISH_SCOPE } from './auth/oauthProvider.js';
import { createOAuthPagesRouter } from './auth/oauthPages.js';
import { Throttle } from './auth/throttle.js';
import { createAdminRouter } from './admin/routes.js';
import { createMcpRouter } from './mcp/http.js';
import { resolveRequest } from './hosting/resolve.js';
import { SiteServer } from './hosting/serve.js';
import { messagePage, notFoundPage } from './hosting/pages.js';
import { isUserError } from './util/errors.js';
import { esc } from './util/html.js';

export type AppBundle = {
  app: Express;
  store: SiteStore;
  provider: A2WOAuthProvider;
  ownerThrottle: Throttle;
  /** Stops background timers; call before closing the database. */
  stop: () => void;
};

export function createApp(config: Config, db: Db): AppBundle {
  const store = new SiteStore(db, config);
  const provider = new A2WOAuthProvider(db, config);
  const ownerThrottle = new Throttle(8, 10 * 60_000);
  const siteServer = new SiteServer(config, store);

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', 'strong');
  // A hop count rather than `true`: express-rate-limit rejects blanket trust.
  app.set('trust proxy', config.trustProxy ? 1 : false);

  // Published sites are matched before anything else, so a request that arrives
  // on a site's own hostname can never reach /admin, /mcp or the OAuth endpoints.
  app.use((req, res, next) => {
    const resolution = resolveRequest(config, store, req.hostname, req.originalUrl);
    switch (resolution.kind) {
      case 'site':
        siteServer.handle(req, res, resolution);
        return;
      case 'redirect':
        res.redirect(301, resolution.location);
        return;
      case 'unknown-site':
        res
          .status(404)
          .setHeader('Content-Type', 'text/html; charset=utf-8')
          .send(
            notFoundPage(
              resolution.slug
                ? `There is no site called "${resolution.slug}" on this server.`
                : 'No site is configured for this hostname.',
            ),
          );
        return;
      default:
        next();
    }
  });

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', sites: store.countSites(), version: process.env.npm_package_version ?? '0.1.0' });
  });

  // OAuth 2.1 authorization server: /authorize, /token, /register, /revoke and
  // the discovery documents Claude needs to find them. Must be mounted at root.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(config.publicUrl),
      baseUrl: new URL(config.publicUrl),
      resourceServerUrl: new URL(config.mcpUrl),
      scopesSupported: [PUBLISH_SCOPE],
      resourceName: 'agent2web',
    }),
  );

  // RFC 9728 puts protected-resource metadata at a path-suffixed URL; some
  // clients still probe the bare path, so answer there too.
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({
      resource: config.mcpUrl,
      authorization_servers: [`${config.publicUrl}/`],
      scopes_supported: [PUBLISH_SCOPE],
      resource_name: 'agent2web',
    });
  });

  app.use('/oauth', createOAuthPagesRouter(config, db, provider, ownerThrottle));
  app.use('/mcp', createMcpRouter(config, { config, store }, provider));
  app.use('/admin', createAdminRouter(config, db, store, ownerThrottle));

  app.get('/', (_req, res) => {
    res
      .status(200)
      .setHeader('Content-Type', 'text/html; charset=utf-8')
      .send(
        messagePage(
          'agent2web',
          'Static site hosting with an MCP publishing endpoint.',
          `<p style="margin:0">MCP endpoint: <code>${esc(config.mcpUrl)}</code><br>
<a href="/admin">Admin</a></p>`,
        ),
      );
  });

  app.use((_req, res) => {
    res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8').send(notFoundPage());
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (isUserError(err)) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[http] unhandled error', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
  });

  const timer = setInterval(
    () => {
      try {
        purgeExpired(db);
        ownerThrottle.sweep();
        siteServer.loginThrottle.sweep();
      } catch (err) {
        console.error('[maintenance] failed', err);
      }
    },
    15 * 60_000,
  );
  timer.unref();

  return { app, store, provider, ownerThrottle, stop: () => clearInterval(timer) };
}
