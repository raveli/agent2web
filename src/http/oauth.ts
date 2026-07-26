import { Hono, type Context } from 'hono';
import type { Env } from './app.js';
import { OAuthError } from '../oauth.js';
import { ADMIN_COOKIE, createAdminSession, csrfToken, csrfValid, getAdminSession } from '../core/session.js';
import { verifyOwner } from '../core/owner.js';
import { consentPage, expiredPage, ownerLoginPage } from '../core/views/oauth.js';
import { card } from '../core/views/layout.js';
import { CORS_HEADERS } from './mcp.js';
import { clientIp, cookie, getCookie, html, isSecure } from './hosting.js';

/**
 * The OAuth endpoints, plus the owner-facing half of the flow.
 *
 * The provider (src/oauth.ts) decides what is valid; these routes decide only how
 * the answer reaches the caller — JSON, or a redirect back to the client.
 */
export function oauthRoutes(): Hono<Env> {
  const app = new Hono<Env>();

  // ------------------------------------------------------------- discovery
  // CORS because browser-based MCP clients fetch these before authenticating.
  app.get('/.well-known/oauth-authorization-server', c =>
    c.json(c.var.oauth.authorizationServerMetadata(), 200, CORS_HEADERS),
  );
  // RFC 9728 puts this at a path-suffixed URL; some clients probe the bare path,
  // so answer at both.
  for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
  ]) {
    app.get(path, c => c.json(c.var.oauth.protectedResourceMetadata(), 200, CORS_HEADERS));
  }

  // ------------------------------------------------------------- authorize
  app.on(['GET', 'POST'], '/authorize', async c => {
    const params =
      c.req.method === 'POST'
        ? await formParams(c)
        : new URL(c.req.url).searchParams;
    try {
      const rid = await c.var.oauth.beginAuthorization(params);
      return c.redirect(`/oauth/consent?rid=${encodeURIComponent(rid)}`, 302);
    } catch (err) {
      return oauthFailure(c, err);
    }
  });

  // -------------------------------------------------- registration + token
  app.post('/register', async c => {
    try {
      const info = await c.var.oauth.register(await c.req.json().catch(() => ({})));
      return c.json(info, 201, { ...CORS_HEADERS, 'Cache-Control': 'no-store' });
    } catch (err) {
      return oauthFailure(c, err);
    }
  });

  app.post('/token', async c => {
    try {
      const tokens = await c.var.oauth.token(await formParams(c));
      return c.json(tokens, 200, { ...CORS_HEADERS, 'Cache-Control': 'no-store' });
    } catch (err) {
      return oauthFailure(c, err);
    }
  });

  app.post('/revoke', async c => {
    await c.var.oauth.revoke(await formParams(c));
    return c.body(null, 200, CORS_HEADERS);
  });

  for (const path of ['/register', '/token', '/revoke']) {
    app.options(path, c => c.body(null, 204, CORS_HEADERS));
  }

  // ------------------------------------------------------- owner + consent
  app.get('/oauth/consent', async c => {
    const rid = new URL(c.req.url).searchParams.get('rid') ?? '';
    const pending = await c.var.oauth.getPending(rid);
    if (!pending) return html(expiredPage(), 400);
    const session = await currentSession(c);
    if (!session) return html(ownerLoginPage(c.var.config, rid));
    return html(
      consentPage(
        c.var.config,
        rid,
        pending,
        await csrfToken(c.var.crypto, c.var.config.secret, session.id),
      ),
    );
  });

  app.post('/oauth/consent', async c => {
    const { config, crypto, sql, oauth, throttles } = c.var;
    const form = await c.req.formData();
    const rid = String(form.get('rid') ?? '');
    const pending = await oauth.getPending(rid);
    if (!pending) return html(expiredPage(), 400);

    const session = await currentSession(c);
    if (!session) {
      const outcome = await verifyOwner(
        config,
        crypto,
        throttles.admin,
        clientIp(c),
        form.get('password'),
        form.get('totp'),
      );
      if (!outcome.ok) {
        return html(ownerLoginPage(config, rid, outcome.error), outcome.status);
      }
      const id = await createAdminSession(sql, crypto, config, `oauth:${pending.client_name}`);
      // Authentication and authorization stay separate steps: show the consent
      // screen rather than approving the moment the password is accepted.
      const body = consentPage(config, rid, pending, await csrfToken(crypto, config.secret, id));
      return html(body, 200, {
        'Set-Cookie': cookie(ADMIN_COOKIE, id, {
          path: '/',
          maxAge: config.adminSessionTtlHours * 3600,
          secure: isSecure(c),
          sameSite: 'Lax',
        }),
      });
    }

    if (!(await csrfValid(crypto, config.secret, session.id, form.get('csrf')))) {
      return html(
        card('Session expired', '<h1>Session expired</h1><p>Reload the page and try again.</p>'),
        403,
      );
    }

    const target =
      form.get('decision') === 'approve' ? await oauth.approve(rid) : await oauth.deny(rid);
    return c.redirect(target, 302);
  });

  app.get('/oauth/expired', c => html(expiredPage(), 400));

  return app;
}

async function currentSession(c: Context<Env>) {
  const id = getCookie(c, ADMIN_COOKIE);
  const row = await getAdminSession(c.var.sql, c.var.crypto, c.var.config.secret, id);
  return row && id ? { id, row } : undefined;
}

async function formParams(c: Context<Env>): Promise<URLSearchParams> {
  const form = await c.req.formData();
  return new URLSearchParams([...form].map(([k, v]) => [k, String(v)] as [string, string]));
}

function oauthFailure(c: Context<Env>, err: unknown): Response {
  if (err instanceof OAuthError) {
    // A validated redirect_uri means the client should learn about this itself.
    if (err.redirectTo) return c.redirect(err.redirectTo, 302);
    return c.json(err.toJSON(), err.status as 400, CORS_HEADERS);
  }
  console.error('[oauth] unhandled error', err);
  return c.json({ error: 'server_error', error_description: 'Internal Server Error' }, 500);
}
