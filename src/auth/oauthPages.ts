import express, { Router, type Request, type Response } from 'express';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { card } from '../ui/layout.js';
import { esc } from '../util/html.js';
import { parseCookies, serializeCookie } from '../util/cookies.js';
import {
  ADMIN_COOKIE,
  createAdminSession,
  csrfToken,
  csrfValid,
  getAdminSession,
} from './session.js';
import { clientIp, verifyOwner } from './owner.js';
import type { A2WOAuthProvider, PendingAuthorization } from './oauthProvider.js';
import { Throttle } from './throttle.js';

const formParser = express.urlencoded({ extended: false, limit: '16kb' });

/**
 * The owner-facing half of the OAuth flow: prove you are the owner, then approve
 * or deny the client that asked for access. `A2WOAuthProvider.authorize()`
 * redirects here after parking the request.
 */
export function createOAuthPagesRouter(
  config: Config,
  db: Db,
  provider: A2WOAuthProvider,
  throttle: Throttle,
): Router {
  const router = Router();

  const loggedIn = (req: Request): boolean =>
    Boolean(getAdminSession(db, config.secret, parseCookies(req.headers.cookie)[ADMIN_COOKIE]));

  const sessionId = (req: Request): string | undefined => parseCookies(req.headers.cookie)[ADMIN_COOKIE];

  router.get('/consent', (req, res) => {
    const rid = typeof req.query.rid === 'string' ? req.query.rid : '';
    const pending = provider.getPendingAuthorization(rid);
    if (!pending) {
      sendExpired(res);
      return;
    }
    if (!loggedIn(req)) {
      res.status(200).send(loginPage(config, rid));
      return;
    }
    res.status(200).send(consentPage(config, rid, pending, csrfToken(config.secret, sessionId(req)!)));
  });

  router.post('/consent', formParser, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rid = typeof body.rid === 'string' ? body.rid : '';
    const pending = provider.getPendingAuthorization(rid);
    if (!pending) {
      sendExpired(res);
      return;
    }

    if (!loggedIn(req)) {
      const outcome = verifyOwner(config, throttle, clientIp(req), body.password, body.totp);
      if (!outcome.ok) {
        res.status(outcome.status).send(loginPage(config, rid, outcome.error));
        return;
      }
      const id = createAdminSession(
        db,
        config.secret,
        config.adminSessionTtlHours,
        `oauth:${pending.client_name}`,
      );
      res.setHeader(
        'Set-Cookie',
        serializeCookie(ADMIN_COOKIE, id, {
          path: '/',
          maxAgeSeconds: config.adminSessionTtlHours * 3600,
          secure: config.publicOrigin.protocol === 'https:',
          sameSite: 'Lax',
        }),
      );
      // Authentication and authorization stay separate steps: show the consent
      // screen rather than approving the moment the password is accepted.
      res.status(200).send(consentPage(config, rid, pending, csrfToken(config.secret, id)));
      return;
    }

    if (!csrfValid(config.secret, sessionId(req)!, body.csrf)) {
      res.status(403).send(card('Session expired', '<h1>Session expired</h1><p>Reload the page and try again.</p>'));
      return;
    }

    if (body.decision === 'approve') {
      res.redirect(302, provider.approve(rid));
      return;
    }
    res.redirect(302, provider.deny(rid));
  });

  router.get('/expired', (_req, res) => sendExpired(res));

  return router;
}

function sendExpired(res: Response): void {
  res
    .status(400)
    .send(
      card(
        'Request expired',
        '<h1>Request expired</h1><p>This authorization request is no longer valid. Start the connection again from your client.</p>',
      ),
    );
}

function loginPage(config: Config, rid: string, error?: string): string {
  const totpField = config.adminTotpSecret
    ? `<label for="totp">Authenticator code</label>
<input id="totp" name="totp" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required>`
    : '';
  return card(
    'Sign in to agent2web',
    `<h1>Sign in to agent2web</h1>
<p>An app is asking to publish sites on your behalf. Sign in as the owner to continue.</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<form method="post" action="/oauth/consent">
  <input type="hidden" name="rid" value="${esc(rid)}">
  <label for="password">Admin password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
  ${totpField}
  <button type="submit">Sign in</button>
</form>`,
  );
}

function consentPage(
  config: Config,
  rid: string,
  pending: PendingAuthorization,
  csrf: string,
): string {
  let redirectHost = pending.redirect_uri;
  try {
    redirectHost = new URL(pending.redirect_uri).host;
  } catch {
    /* fall back to the raw value */
  }
  return card(
    'Authorize connection',
    `<h1>Authorize connection</h1>
<p>Approve only if you started this from a client you trust.</p>
<dl>
  <dt>Application</dt><dd>${esc(pending.client_name)}</dd>
  <dt>Redirects to</dt><dd>${esc(redirectHost)}</dd>
  <dt>Permission</dt><dd>Publish, update and delete sites on ${esc(config.publicOrigin.host)}</dd>
</dl>
<form method="post" action="/oauth/consent" class="row">
  <input type="hidden" name="rid" value="${esc(rid)}">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <button type="submit" name="decision" value="deny" class="secondary">Deny</button>
  <button type="submit" name="decision" value="approve">Approve</button>
</form>`,
  );
}
