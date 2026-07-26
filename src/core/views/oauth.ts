import type { Config } from '../config.js';
import type { PendingAuthorization } from '../../oauth.js';
import { card } from './layout.js';
import { esc } from '../../util/html.js';

export function ownerLoginPage(config: Config, rid: string, error?: string): string {
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

export function consentPage(
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

export function expiredPage(): string {
  return card(
    'Request expired',
    '<h1>Request expired</h1><p>This authorization request is no longer valid. Start the connection again from your client.</p>',
  );
}
