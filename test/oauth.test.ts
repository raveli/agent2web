import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { ADMIN_PASSWORD, API_TOKEN, cookieValue, json, mcpRequest, startHarness, type Harness } from './helpers.js';

let h: Harness;
const REDIRECT_URI = 'http://127.0.0.1:54321/oauth/callback';

before(async () => {
  h = await startHarness();
});
after(async () => h.close());

test('unauthenticated MCP requests advertise where to authenticate', async () => {
  const res = await fetch(`${h.baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(res.status, 401);
  const header = res.headers.get('www-authenticate') ?? '';
  assert.match(header, /^Bearer /);
  assert.match(header, /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.match(header, /scope="publish"/);
});

test('an invalid bearer token is rejected', async () => {
  const res = await mcpRequest(h.baseUrl, 'not-a-real-token', 'tools/list');
  assert.equal(res.status, 401);
});

test('the static API token authenticates without OAuth', async () => {
  const res = await mcpRequest(h.baseUrl, API_TOKEN, 'tools/list');
  assert.equal(res.status, 200);
  assert.ok(res.result.tools.length > 0);
});

test('protected resource metadata points at this server as the authorization server', async () => {
  const res = await fetch(`${h.baseUrl}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.resource, `${h.baseUrl}/mcp`);
  assert.deepEqual(body.authorization_servers, [`${h.baseUrl}/`]);
  assert.deepEqual(body.scopes_supported, ['publish']);

  // Some clients probe the bare path as well.
  const bare = await fetch(`${h.baseUrl}/.well-known/oauth-protected-resource`);
  assert.equal(bare.status, 200);
  assert.equal((await json(bare)).resource, `${h.baseUrl}/mcp`);
});

test('authorization server metadata declares PKCE, DCR and public clients', async () => {
  const res = await fetch(`${h.baseUrl}/.well-known/oauth-authorization-server`);
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.authorization_endpoint, `${h.baseUrl}/authorize`);
  assert.equal(body.token_endpoint, `${h.baseUrl}/token`);
  assert.equal(body.registration_endpoint, `${h.baseUrl}/register`);
  assert.equal(body.revocation_endpoint, `${h.baseUrl}/revoke`);
  assert.deepEqual(body.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(body.response_types_supported, ['code']);
  assert.ok(body.grant_types_supported.includes('authorization_code'));
  assert.ok(body.grant_types_supported.includes('refresh_token'));
  assert.ok(body.token_endpoint_auth_methods_supported.includes('none'));
});

test('registration rejects redirect URIs outside the policy', async () => {
  for (const uri of [
    'https://evil.example.com/callback',
    'http://8.8.8.8:80/cb',
    'not-a-url',
    'https://claude.ai.evil.example.com/cb',
    'https://user:pass@claude.ai/cb',
    'http://claude.ai/cb',
  ]) {
    const res = await register({ redirect_uris: [uri] });
    assert.equal(res.status, 400, `${uri} should be refused`);
    assert.match(JSON.stringify(await json(res)), /redirect_uri/);
  }
});

test('registration rejects confidential clients with an actionable message', async () => {
  const res = await register({
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: 'client_secret_post',
  });
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(await json(res)), /public clients/);
});

test("Claude's hosted callback is accepted", async () => {
  const res = await register({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
  assert.equal(res.status, 201);
  const body = await json(res);
  assert.equal(body.token_endpoint_auth_method, 'none');
  assert.ok(!body.client_secret);
});

test('full authorization code flow with PKCE, then publish with the issued token', async () => {
  const client = await registerLoopbackClient();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  // 1. /authorize parks the request and sends the owner to the consent page.
  const authorizeUrl = new URL(`${h.baseUrl}/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'state-123',
    resource: `${h.baseUrl}/mcp`,
    scope: 'publish',
  }).toString();
  const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
  assert.equal(authorize.status, 302);
  const consentLocation = authorize.headers.get('location')!;
  assert.match(consentLocation, /^\/oauth\/consent\?rid=/);
  const rid = new URL(consentLocation, h.baseUrl).searchParams.get('rid')!;

  // 2. Without a session the consent URL asks for the owner password.
  const loginPage = await fetch(`${h.baseUrl}${consentLocation}`);
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /Admin password/);

  // 3. A wrong password does not advance the flow.
  const badLogin = await postConsent({ rid, password: 'wrong-password' });
  assert.equal(badLogin.status, 401);

  // 4. Correct password → session cookie + consent screen (not auto-approval).
  const login = await postConsent({ rid, password: ADMIN_PASSWORD });
  assert.equal(login.status, 200);
  const loginBody = await login.text();
  assert.match(loginBody, /Authorize connection/);
  assert.match(loginBody, /Publish, update and delete sites/);
  const session = cookieValue(login.headers.getSetCookie(), 'a2w_admin')!;
  assert.ok(session, 'expected an admin session cookie');
  const csrf = /name="csrf" value="([^"]+)"/.exec(loginBody)![1]!;

  // 5. Approving redirects back to the client with a code.
  const approved = await postConsent({ rid, csrf, decision: 'approve' }, session);
  assert.equal(approved.status, 302);
  const back = new URL(approved.headers.get('location')!);
  assert.equal(`${back.origin}${back.pathname}`, REDIRECT_URI);
  assert.equal(back.searchParams.get('state'), 'state-123');
  const code = back.searchParams.get('code')!;
  assert.ok(code);

  // 6. Exchange the code (PKCE verified by the token endpoint).
  const tokenRes = await token({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    resource: `${h.baseUrl}/mcp`,
  });
  assert.equal(tokenRes.status, 200);
  const tokens = await json(tokenRes);
  assert.equal(tokens.token_type, 'Bearer');
  assert.equal(tokens.scope, 'publish');
  assert.ok(tokens.expires_in > 0);
  assert.ok(tokens.refresh_token);

  // 7. The access token works against the MCP endpoint.
  const list = await mcpRequest(h.baseUrl, tokens.access_token, 'tools/list');
  assert.equal(list.status, 200);
  const publish = await mcpRequest(h.baseUrl, tokens.access_token, 'tools/call', {
    name: 'site_publish',
    arguments: {
      slug: 'via-oauth',
      html: '<p>published over oauth</p>',
      visibility: 'public',
      confirm_public: true,
    },
  });
  assert.equal(publish.result.isError, undefined);
  assert.match(await (await fetch(`${h.baseUrl}/s/via-oauth/`)).text(), /published over oauth/);

  // 8. Refresh rotates the pair, and the superseded refresh token is dead.
  const refreshed = await token({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: client.client_id,
  });
  assert.equal(refreshed.status, 200);
  const rotated = await json(refreshed);
  assert.notEqual(rotated.access_token, tokens.access_token);
  assert.ok(rotated.refresh_token);
  assert.equal((await mcpRequest(h.baseUrl, rotated.access_token, 'tools/list')).status, 200);

  // Replaying a spent refresh token means it leaked: the whole chain is revoked.
  const reuse = await token({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: client.client_id,
  });
  assert.equal(reuse.status, 400);
  assert.equal((await json(reuse)).error, 'invalid_grant');
  assert.equal((await mcpRequest(h.baseUrl, rotated.access_token, 'tools/list')).status, 401);

  // 9. The authorization code cannot be replayed either.
  const replay = await token({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
  });
  assert.equal(replay.status, 400);
  assert.equal((await json(replay)).error, 'invalid_grant');
});

test('replaying an authorization code revokes tokens already issued from it', async () => {
  const client = await registerLoopbackClient();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const code = await authorizeAndApprove(client.client_id, challenge);
  const exchange = {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
  };
  const tokens = await json(await token(exchange));
  assert.equal((await mcpRequest(h.baseUrl, tokens.access_token, 'tools/list')).status, 200);

  const replay = await token(exchange);
  assert.equal(replay.status, 400);
  // OAuth 2.1: on code reuse the server should revoke everything issued from it.
  assert.equal((await mcpRequest(h.baseUrl, tokens.access_token, 'tools/list')).status, 401);
});

test('a PKCE verifier that does not match the challenge is refused', async () => {
  const client = await registerLoopbackClient();
  const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
  const code = await authorizeAndApprove(client.client_id, challenge);
  const res = await token({
    grant_type: 'authorization_code',
    code,
    code_verifier: randomBytes(32).toString('base64url'),
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
  });
  assert.equal(res.status, 400);
  assert.equal((await json(res)).error, 'invalid_grant');
});

test('tokens for another resource are refused at authorization time', async () => {
  const client = await registerLoopbackClient();
  const url = new URL(`${h.baseUrl}/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    code_challenge: 'abc123abc123abc123abc123abc123abc123abc1',
    code_challenge_method: 'S256',
    resource: 'https://someone-elses-server.example.com/mcp',
  }).toString();
  const res = await fetch(url, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location')!);
  assert.equal(location.searchParams.get('error'), 'invalid_target');
});

test('denying the request sends access_denied back to the client', async () => {
  const client = await registerLoopbackClient();
  const { rid, session, csrf } = await authorizeUpToConsent(client.client_id, 'challenge-value-placeholder-000000000000');
  const res = await postConsent({ rid, csrf, decision: 'deny' }, session);
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location')!);
  assert.equal(location.searchParams.get('error'), 'access_denied');
});

test('the consent form is CSRF protected', async () => {
  const client = await registerLoopbackClient();
  const { rid, session } = await authorizeUpToConsent(client.client_id, 'challenge-value-placeholder-000000000000');
  const res = await postConsent({ rid, csrf: 'forged', decision: 'approve' }, session);
  assert.equal(res.status, 403);
});

test('an expired authorization request cannot be approved', async () => {
  const client = await registerLoopbackClient();
  const { rid, session, csrf } = await authorizeUpToConsent(client.client_id, 'challenge-value-placeholder-000000000000');
  await h.db.run('UPDATE oauth_auth_requests SET expires_at = ? WHERE id = ?', Date.now() - 1000, rid);
  const res = await postConsent({ rid, csrf, decision: 'approve' }, session);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /expired/i);
});

test('revoked access tokens stop working', async () => {
  const client = await registerLoopbackClient();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const code = await authorizeAndApprove(client.client_id, challenge);
  const tokens = await json(
    await token({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
    }),
  );
  assert.equal((await mcpRequest(h.baseUrl, tokens.access_token, 'tools/list')).status, 200);

  const revoke = await fetch(`${h.baseUrl}/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: tokens.access_token, client_id: client.client_id }).toString(),
  });
  assert.equal(revoke.status, 200);
  assert.equal((await mcpRequest(h.baseUrl, tokens.access_token, 'tools/list')).status, 401);
});

test('GET and DELETE on the MCP endpoint report that the server is stateless', async () => {
  for (const method of ['GET', 'DELETE']) {
    const res = await fetch(`${h.baseUrl}/mcp`, {
      method,
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
  }
});

// ------------------------------------------------------------------ helpers

function register(metadata: Record<string, unknown>) {
  return fetch(`${h.baseUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test Client', token_endpoint_auth_method: 'none', ...metadata }),
  });
}

async function registerLoopbackClient(): Promise<{ client_id: string }> {
  const res = await register({ redirect_uris: [REDIRECT_URI] });
  assert.equal(res.status, 201, `registration failed: ${await res.clone().text()}`);
  return json(res);
}

function token(params: Record<string, string>) {
  return fetch(`${h.baseUrl}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

function postConsent(fields: Record<string, string>, session?: string) {
  return fetch(`${h.baseUrl}/oauth/consent`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(session ? { cookie: `a2w_admin=${encodeURIComponent(session)}` } : {}),
    },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
}

async function authorizeUpToConsent(
  clientId: string,
  challenge: string,
): Promise<{ rid: string; session: string; csrf: string }> {
  const url = new URL(`${h.baseUrl}/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  const authorize = await fetch(url, { redirect: 'manual' });
  assert.equal(authorize.status, 302);
  const rid = new URL(authorize.headers.get('location')!, h.baseUrl).searchParams.get('rid')!;
  const login = await postConsent({ rid, password: ADMIN_PASSWORD });
  const body = await login.text();
  return {
    rid,
    session: cookieValue(login.headers.getSetCookie(), 'a2w_admin')!,
    csrf: /name="csrf" value="([^"]+)"/.exec(body)![1]!,
  };
}

async function authorizeAndApprove(clientId: string, challenge: string): Promise<string> {
  const { rid, session, csrf } = await authorizeUpToConsent(clientId, challenge);
  const approved = await postConsent({ rid, csrf, decision: 'approve' }, session);
  assert.equal(approved.status, 302);
  return new URL(approved.headers.get('location')!).searchParams.get('code')!;
}
