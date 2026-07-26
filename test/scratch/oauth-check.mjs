import { Miniflare } from 'miniflare';
import { createHash, randomBytes } from 'node:crypto';
import { WebCryptoProvider } from '../../build/src/core/crypto.js';
import { migrate } from '../../build/src/core/schema.js';
import { Sql } from '../../build/src/d1.js';
import { loadConfig } from '../../build/src/core/config.js';
import { OAuthServer, OAuthError } from '../../build/src/oauth.js';

const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch: () => new Response("ok") }',
  d1Databases: ['DB'],
});
await mf.ready;
const sql = new Sql(await mf.getD1Database('DB'));
await migrate(sql);

const crypto = new WebCryptoProvider();
const config = await loadConfig(
  {
    A2W_PUBLIC_URL: 'https://a2w.example.com',
    A2W_SECRET: 'x'.repeat(40),
    A2W_ADMIN_PASSWORD: 'a-long-enough-password',
  },
  crypto,
);
const oauth = new OAuthServer(sql, config, crypto);

const ok = [], bad = [];
const check = (l, pass, d = '') => (pass ? ok : bad).push(`${l}${d ? ' — ' + d : ''}`);
const expectError = async (label, fn, code) => {
  try { await fn(); check(label, false, 'no error thrown'); }
  catch (e) { check(label, e instanceof OAuthError && e.code === code, `${e.code ?? e.message}`); }
};

// PKCE challenge computed independently of our implementation, so a wrong
// encoding on our side shows up as a failure rather than agreeing with itself.
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');

// ---- discovery -----------------------------------------------------------
const as = oauth.authorizationServerMetadata();
check('issuer has trailing slash', as.issuer === 'https://a2w.example.com/', as.issuer);
check('endpoints absolute', as.token_endpoint === 'https://a2w.example.com/token');
check('S256 only', JSON.stringify(as.code_challenge_methods_supported) === '["S256"]');
check('public clients only', JSON.stringify(as.token_endpoint_auth_methods_supported) === '["none"]');
const prm = oauth.protectedResourceMetadata();
check('resource is the mcp url', prm.resource === 'https://a2w.example.com/mcp');
check('points back at this AS', prm.authorization_servers[0] === 'https://a2w.example.com/');

// ---- registration --------------------------------------------------------
await expectError('confidential client rejected',
  () => oauth.register({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'client_secret_post' }),
  'invalid_client_metadata');
for (const uri of ['https://evil.example.com/cb', 'https://claude.ai.evil.example.com/cb', 'http://8.8.8.8/cb', 'https://a2w.example.com/s/x/', 'not-a-url']) {
  await expectError(`redirect refused: ${uri}`, () => oauth.register({ redirect_uris: [uri] }), 'invalid_client_metadata');
}
const claude = await oauth.register({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
check('claude.ai accepted', !!claude.client_id && claude.token_endpoint_auth_method === 'none');
const cli = await oauth.register({ client_name: 'Inspector', redirect_uris: ['http://127.0.0.1:6274/oauth/callback'] });
check('loopback accepted', !!cli.client_id);
check('no secret issued', !('client_secret' in cli));

// ---- authorize -----------------------------------------------------------
const authorizeParams = (over = {}) => new URLSearchParams({
  response_type: 'code', client_id: cli.client_id,
  redirect_uri: 'http://127.0.0.1:6274/oauth/callback',
  code_challenge: challenge, code_challenge_method: 'S256',
  state: 'state-123', resource: 'https://a2w.example.com/mcp', ...over,
});

await expectError('unknown client', () => oauth.beginAuthorization(authorizeParams({ client_id: 'nope' })), 'invalid_client');
await expectError('unregistered redirect', () => oauth.beginAuthorization(authorizeParams({ redirect_uri: 'https://evil.example.com/cb' })), 'invalid_request');
await expectError('missing PKCE', () => oauth.beginAuthorization(authorizeParams({ code_challenge: '' })), 'invalid_request');
await expectError('plain PKCE refused', () => oauth.beginAuthorization(authorizeParams({ code_challenge_method: 'plain' })), 'invalid_request');
await expectError('wrong audience', () => oauth.beginAuthorization(authorizeParams({ resource: 'https://someone-else.example/mcp' })), 'invalid_target');

// post-redirect errors must carry the redirect, pre-redirect ones must not
try { await oauth.beginAuthorization(authorizeParams({ code_challenge: '' })); } catch (e) {
  check('post-redirect error redirects', !!e.redirectTo && e.redirectTo.startsWith('http://127.0.0.1:6274/'), e.redirectTo);
}
try { await oauth.beginAuthorization(authorizeParams({ client_id: 'nope' })); } catch (e) {
  check('pre-redirect error does not', e.redirectTo === undefined);
}

const rid = await oauth.beginAuthorization(authorizeParams());
const pending = await oauth.getPending(rid);
check('request parked', pending?.client_name === 'Inspector', pending?.client_name);
check('no code before approval', (await sql.all('SELECT * FROM oauth_codes')).length === 0);

// ---- deny ----------------------------------------------------------------
const denyRid = await oauth.beginAuthorization(authorizeParams());
const denied = new URL(await oauth.deny(denyRid));
check('deny → access_denied', denied.searchParams.get('error') === 'access_denied');
check('deny preserves state', denied.searchParams.get('state') === 'state-123');
check('denied request consumed', (await oauth.getPending(denyRid)) === undefined);

// ---- approve + exchange --------------------------------------------------
const approved = new URL(await oauth.approve(rid));
const code = approved.searchParams.get('code');
check('approve → code + state', !!code && approved.searchParams.get('state') === 'state-123');
check('approved request consumed', (await oauth.getPending(rid)) === undefined);

const form = o => new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: cli.client_id, redirect_uri: 'http://127.0.0.1:6274/oauth/callback', ...o });
await expectError('wrong verifier', () => oauth.token(form({ code_verifier: randomBytes(32).toString('base64url') })), 'invalid_grant');
await expectError('redirect mismatch', () => oauth.token(form({ redirect_uri: 'http://127.0.0.1:9999/cb' })), 'invalid_grant');
await expectError('wrong client', () => oauth.token(form({ client_id: claude.client_id })), 'invalid_grant');

const tokens = await oauth.token(form());
check('tokens issued', tokens.token_type === 'Bearer' && tokens.scope === 'publish' && tokens.expires_in === 3600);
check('access token valid', (await oauth.verifyAccessToken(tokens.access_token))?.scopes.join() === 'publish');
check('refresh is not an access token', (await oauth.verifyAccessToken(tokens.refresh_token)) === undefined);
check('garbage token invalid', (await oauth.verifyAccessToken('nonsense')) === undefined);

// ---- refresh rotation ----------------------------------------------------
const refreshed = await oauth.token(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: cli.client_id }));
check('rotation issues new pair', refreshed.access_token !== tokens.access_token && refreshed.refresh_token !== tokens.refresh_token);
check('new access token works', !!(await oauth.verifyAccessToken(refreshed.access_token)));

await expectError('spent refresh rejected',
  () => oauth.token(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: cli.client_id })),
  'invalid_grant');
check('reuse revokes the chain', (await oauth.verifyAccessToken(refreshed.access_token)) === undefined);

// ---- code replay ---------------------------------------------------------
const rid2 = await oauth.beginAuthorization(authorizeParams());
const code2 = new URL(await oauth.approve(rid2)).searchParams.get('code');
const form2 = { grant_type: 'authorization_code', code: code2, code_verifier: verifier, client_id: cli.client_id };
const tokens2 = await oauth.token(new URLSearchParams(form2));
check('second flow works', !!(await oauth.verifyAccessToken(tokens2.access_token)));
await expectError('replay rejected', () => oauth.token(new URLSearchParams(form2)), 'invalid_grant');
check('replay revokes issued tokens', (await oauth.verifyAccessToken(tokens2.access_token)) === undefined);

// ---- revocation + expiry + audience -------------------------------------
const rid3 = await oauth.beginAuthorization(authorizeParams());
const code3 = new URL(await oauth.approve(rid3)).searchParams.get('code');
const tokens3 = await oauth.token(new URLSearchParams({ grant_type: 'authorization_code', code: code3, code_verifier: verifier, client_id: cli.client_id }));
await oauth.revoke(new URLSearchParams({ token: tokens3.access_token, client_id: cli.client_id }));
check('revoked token rejected', (await oauth.verifyAccessToken(tokens3.access_token)) === undefined);

const rid4 = await oauth.beginAuthorization(authorizeParams());
const code4 = new URL(await oauth.approve(rid4)).searchParams.get('code');
const tokens4 = await oauth.token(new URLSearchParams({ grant_type: 'authorization_code', code: code4, code_verifier: verifier, client_id: cli.client_id }));
await sql.run('UPDATE oauth_tokens SET expires_at = ? WHERE kind = ? AND revoked = 0', Date.now() - 1000, 'access');
check('expired token rejected', (await oauth.verifyAccessToken(tokens4.access_token)) === undefined);
await sql.run("UPDATE oauth_tokens SET expires_at = ?, resource = 'https://elsewhere.example/mcp' WHERE token_hash = ?", Date.now() + 60000, await crypto.hmac(config.secret, tokens4.access_token));
check('wrong-audience token rejected', (await oauth.verifyAccessToken(tokens4.access_token)) === undefined);

await expectError('unsupported grant', () => oauth.token(new URLSearchParams({ grant_type: 'client_credentials', client_id: cli.client_id })), 'unsupported_grant_type');

console.log('\n' + ok.map(l => '  ok   ' + l).join('\n'));
if (bad.length) console.log('\n' + bad.map(l => '  FAIL ' + l).join('\n'));
console.log(`\n${ok.length} passed, ${bad.length} failed`);
await mf.dispose();
process.exit(bad.length ? 1 : 0);
