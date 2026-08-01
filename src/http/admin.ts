import { Hono, type Context } from 'hono';
import type { Env } from './app.js';
import type { Visibility } from '../store.js';
import {
  ADMIN_COOKIE,
  createAdminSession,
  csrfToken,
  csrfValid,
  destroyAdminSession,
  getAdminSession,
} from '../core/session.js';
import { verifyOwner } from '../core/owner.js';
import {
  adminLoginPage,
  connectionsPage,
  siteDetailPage,
  sitesPage,
  type ConnectionEntry,
  type SiteListEntry,
} from '../core/views/admin.js';
import { messageFor } from '../util/errors.js';
import { clientIp, cookie, getCookie, html, isSecure } from './hosting.js';
import { rememberPublicUrl } from '../public-url.js';

/** Shape the connections view needs; the row itself lives in D1. */
export type OAuthClientRow = {
  client_id: string;
  client_secret_hash: string | null;
  client_id_issued_at: number;
  client_secret_expires_at: number | null;
  metadata: string;
  created_at: number;
};

export function adminRoutes(): Hono<Env> {
  const app = new Hono<Env>();

  app.get('/login', async c => {
    if (await currentSession(c)) return c.redirect('/admin', 302);
    return html(adminLoginPage(c.var.config, undefined, safeNext(new URL(c.req.url).searchParams.get('next'))));
  });

  app.post('/login', async c => {
    const { config, crypto, sql, throttles } = c.var;
    const form = await c.req.formData();
    const next = safeNext(form.get('next'));
    const outcome = await verifyOwner(
      config,
      crypto,
      throttles.admin,
      clientIp(c),
      form.get('password'),
      form.get('totp'),
    );
    if (!outcome.ok) return html(adminLoginPage(config, outcome.error, next), outcome.status);

    const id = await createAdminSession(sql, crypto, config, 'admin-ui');
    // The owner reached us on this origin, so it is safe to record as the
    // canonical one. Anonymous requests never get to do this.
    c.executionCtx.waitUntil(rememberPublicUrl(sql, c.req.url));
    return new Response(null, {
      status: 303,
      headers: {
        Location: next,
        'Set-Cookie': cookie(ADMIN_COOKIE, id, {
          path: '/',
          maxAge: config.adminSessionTtlHours * 3600,
          secure: isSecure(c),
          sameSite: 'Lax',
        }),
      },
    });
  });

  // Everything below requires a session.
  app.use('*', async (c, next) => {
    if (new URL(c.req.url).pathname === '/admin/login') return next();
    const session = await currentSession(c);
    if (!session) {
      return c.redirect(`/admin/login?next=${encodeURIComponent(new URL(c.req.url).pathname)}`, 302);
    }
    c.set('session', session);
    return next();
  });

  app.post('/logout', async c => {
    const { sql, crypto, config } = c.var;
    const session = c.var.session!;
    if (!(await csrfValid(crypto, config.secret, session.id, (await c.req.formData()).get('csrf')))) {
      return c.text('Invalid CSRF token. Reload the admin page and try again.', 403);
    }
    await destroyAdminSession(sql, crypto, config.secret, session.id);
    return new Response(null, {
      status: 303,
      headers: {
        Location: '/admin/login',
        'Set-Cookie': cookie(ADMIN_COOKIE, '', { path: '/', maxAge: 0, secure: isSecure(c) }),
      },
    });
  });

  app.get('/', async c => {
    const { store, config, crypto } = c.var;
    const { rows } = await store.listSites(200, 0);
    const entries: SiteListEntry[] = [];
    for (const site of rows) {
      const versions = await store.listVersions(site.id, 1000);
      const current = versions.find(v => v.id === site.current_version_id);
      entries.push({ site, versionCount: versions.length, bytes: current?.bytes ?? 0 });
    }
    return html(
      sitesPage(
        config,
        entries,
        await csrfToken(crypto, config.secret, c.var.session!.id),
        flash(c),
      ),
    );
  });

  app.get('/sites/:slug', async c => {
    const { store, config, crypto } = c.var;
    const slug = String(c.req.param('slug'));
    const site = await store.getSiteBySlug(slug);
    if (!site) {
      return c.redirect(`/admin?err=${encodeURIComponent(`No site called "${slug}".`)}`, 303);
    }
    return html(
      siteDetailPage(
        config,
        {
          site,
          versions: await store.listVersions(site.id, 1000),
          files: site.current_version_id ? await store.listFiles(site.current_version_id) : [],
        },
        await csrfToken(crypto, config.secret, c.var.session!.id),
        flash(c),
      ),
    );
  });

  app.get('/connections', async c => {
    const { sql, config, crypto } = c.var;
    const clients = await sql.all<OAuthClientRow>(
      'SELECT * FROM oauth_clients ORDER BY created_at DESC',
    );
    const now = Date.now();
    const entries: ConnectionEntry[] = [];
    for (const client of clients) {
      const metadata = JSON.parse(client.metadata) as {
        client_name?: string;
        redirect_uris?: string[];
      };
      const counts = await sql.all<{ kind: string; n: number; last: number }>(
        `SELECT kind, COUNT(*) AS n, MAX(created_at) AS last FROM oauth_tokens
          WHERE client_id = ? AND revoked = 0 AND expires_at > ? GROUP BY kind`,
        client.client_id,
        now,
      );
      const access = counts.find(x => x.kind === 'access');
      const refresh = counts.find(x => x.kind === 'refresh');
      entries.push({
        client,
        name: metadata.client_name ?? client.client_id,
        redirectUris: metadata.redirect_uris ?? [],
        activeAccessTokens: access?.n ?? 0,
        activeRefreshTokens: refresh?.n ?? 0,
        lastIssuedAt: Math.max(access?.last ?? 0, refresh?.last ?? 0) || null,
      });
    }
    return html(
      connectionsPage(
        config,
        entries,
        await csrfToken(crypto, config.secret, c.var.session!.id),
        flash(c),
      ),
    );
  });

  /**
   * Wraps a mutation so it always lands back on a page with a message. Handlers
   * return where to go next, which is the site's own page unless the site is gone.
   */
  const action =
    (handler: (c: Context<Env>, form: FormData) => Promise<{ message: string; to: string }>) =>
    async (c: Context<Env>) => {
      const { crypto, config } = c.var;
      const form = await c.req.formData();
      if (!(await csrfValid(crypto, config.secret, c.var.session!.id, form.get('csrf')))) {
        return c.text('Invalid CSRF token. Reload the admin page and try again.', 403);
      }
      const back = `/admin/sites/${encodeURIComponent(String(c.req.param('slug')) ?? '')}`;
      try {
        const { message, to } = await handler(c, form);
        return c.redirect(`${to}?ok=${encodeURIComponent(message)}`, 303);
      } catch (err) {
        return c.redirect(`${back}?err=${encodeURIComponent(messageFor(err))}`, 303);
      }
    };

  const sitePath = (slug: string) => `/admin/sites/${encodeURIComponent(slug)}`;

  app.post(
    '/sites/:slug/access',
    action(async (c, form) => {
      const visibility = String(form.get('visibility') ?? 'public') as Visibility;
      const raw = form.get('password');
      const password = typeof raw === 'string' && raw ? raw : null;
      const { site, generatedPassword } = await c.var.store.setAccess(
        String(c.req.param('slug')),
        visibility,
        password,
      );
      const message =
        site.visibility === 'password'
          ? password
            ? 'Password saved. Anyone who unlocked the site with the old one has to enter the new one.'
            : generatedPassword
              ? `Visitors now need this password, shown once: ${generatedPassword}`
              : 'Visitors now need the password.'
          : site.visibility === 'disabled'
            ? 'The site now returns 404. Its files are kept.'
            : 'Anyone with the link can now see the site.';
      return { message, to: sitePath(site.slug) };
    }),
  );

  app.post(
    '/sites/:slug/domain',
    action(async (c, form) => {
      const raw = String(form.get('domain') ?? '').trim();
      const site = await c.var.store.setDomain(String(c.req.param('slug')), raw || null);
      return {
        message: site.custom_domain
          ? `Answering for ${site.custom_domain}. Point its DNS here and add it as a Custom Hostname or Workers route.`
          : 'Custom domain removed.',
        to: sitePath(site.slug),
      };
    }),
  );

  app.post(
    '/sites/:slug/rollback',
    action(async (c, form) => {
      const { site, version } = await c.var.store.rollback(
        String(c.req.param('slug')),
        String(form.get('version_id') ?? ''),
      );
      return {
        message: `Now serving the version published ${new Date(version.created_at)
          .toISOString()
          .slice(0, 16)
          .replace('T', ' ')}Z.`,
        to: sitePath(site.slug),
      };
    }),
  );

  app.post(
    '/sites/:slug/delete',
    action(async c => {
      const site = await c.var.store.deleteSite(String(c.req.param('slug')));
      return { message: `Deleted ${site.slug}.`, to: '/admin' };
    }),
  );

  app.post('/connections/:clientId/revoke', async c => {
    const { sql, crypto, config } = c.var;
    const form = await c.req.formData();
    if (!(await csrfValid(crypto, config.secret, c.var.session!.id, form.get('csrf')))) {
      return c.text('Invalid CSRF token. Reload the admin page and try again.', 403);
    }
    const clientId = String(c.req.param('clientId'));
    await sql.batch([
      { sql: 'UPDATE oauth_tokens SET revoked = 1 WHERE client_id = ?', params: [clientId] },
      { sql: 'DELETE FROM oauth_codes WHERE client_id = ?', params: [clientId] },
      { sql: 'DELETE FROM oauth_auth_requests WHERE client_id = ?', params: [clientId] },
      { sql: 'DELETE FROM oauth_clients WHERE client_id = ?', params: [clientId] },
    ]);
    return c.redirect('/admin/connections?ok=Connection+revoked', 303);
  });

  return app;
}

async function currentSession(c: Context<Env>) {
  const id = getCookie(c, ADMIN_COOKIE);
  const row = await getAdminSession(c.var.sql, c.var.crypto, c.var.config.secret, id);
  return row && id ? { id, row } : undefined;
}

function safeNext(value: unknown): string {
  if (typeof value !== 'string') return '/admin';
  // Backslashes are normalised to slashes by browsers, so they can escape the
  // origin the same way a leading "//" does.
  if (!value.startsWith('/admin') || value.startsWith('//') || value.includes('\\')) return '/admin';
  return value;
}

function flash(c: Context<Env>): { ok?: string; err?: string } {
  const params = new URL(c.req.url).searchParams;
  const ok = params.get('ok')?.slice(0, 300);
  const err = params.get('err')?.slice(0, 300);
  return { ok: ok ?? undefined, err: err ?? undefined };
}
