import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { API_TOKEN, callTool, startHarness, structured, textOf, type Harness } from './helpers.js';

/**
 * Private by default.
 *
 * The job this product does is turning something you would not publish into a
 * page. Defaulting that to world-readable, under a slug derived from the title,
 * is the wrong way round: an agent that forgets an argument should fail closed.
 *
 * So a new site is password protected unless the caller says otherwise, and
 * saying otherwise takes a deliberate acknowledgement rather than a value in a
 * field the model may not have thought about. When nobody supplies a password
 * we mint one and return it once, because a locked site with no password is a
 * site nobody can open.
 */

let h: Harness;

before(async () => {
  h = await startHarness();
});
after(async () => h.close());

const publish = (args: Record<string, unknown>) =>
  callTool(h.baseUrl, API_TOKEN, 'site_publish', { html: '<p>hi</p>', ...args });

test('a site with no access arguments is password protected, not public', async () => {
  const { result } = await publish({ slug: 'default-private' });
  assert.notEqual(result.isError, true, textOf(result));
  const data = structured(result);
  assert.equal(data.visibility, 'password');
  assert.equal(data.password_protected, true);
});

test('the generated password is returned once, and actually opens the site', async () => {
  const { result } = await publish({ slug: 'minted' });
  const password = structured(result).generated_password;
  assert.ok(typeof password === 'string' && password.length >= 12, 'expected a generated password');
  // An agent reading markdown has to see it too, or it cannot pass it on.
  assert.ok(textOf(result).includes(password), 'the password must appear in the text rendering');

  assert.equal((await fetch(`${h.baseUrl}/s/minted/`)).status, 401);
  const opened = await fetch(`${h.baseUrl}/s/minted/`, {
    headers: { authorization: 'Basic ' + Buffer.from(`:${password}`).toString('base64') },
  });
  assert.equal(opened.status, 200);
  assert.match(await opened.text(), /hi/);
});

test('a supplied password is used as-is and nothing is minted', async () => {
  const { result } = await publish({ slug: 'chosen', password: 'my-own-password' });
  assert.equal(structured(result).visibility, 'password');
  assert.equal(structured(result).generated_password, undefined);
  const opened = await fetch(`${h.baseUrl}/s/chosen/`, {
    headers: { authorization: 'Basic ' + Buffer.from(':my-own-password').toString('base64') },
  });
  assert.equal(opened.status, 200);
});

test('asking for password protection without a password mints one instead of bricking the site', async () => {
  // This used to write a null hash and deny every request forever.
  const { result } = await publish({ slug: 'no-brick', visibility: 'password' });
  const password = structured(result).generated_password;
  assert.ok(password, 'expected a minted password rather than an unopenable site');
  const opened = await fetch(`${h.baseUrl}/s/no-brick/`, {
    headers: { authorization: 'Basic ' + Buffer.from(`:${password}`).toString('base64') },
  });
  assert.equal(opened.status, 200);
});

test('publishing publicly is refused without an explicit acknowledgement', async () => {
  const { result } = await publish({ slug: 'wide-open', visibility: 'public' });
  assert.equal(result.isError, true);
  const message = textOf(result);
  assert.match(message, /confirm_public/, 'the error must name the argument that unblocks it');
  assert.match(message, /anyone with the link/i, 'and say plainly what public means');
  // Nothing should have been created.
  const check = await callTool(h.baseUrl, API_TOKEN, 'site_get', { slug: 'wide-open' });
  assert.equal(check.result.isError, true);
});

test('with the acknowledgement, a public site publishes normally', async () => {
  const { result } = await publish({ slug: 'wide-open', visibility: 'public', confirm_public: true });
  assert.notEqual(result.isError, true, textOf(result));
  assert.equal(structured(result).visibility, 'public');
  assert.equal((await fetch(`${h.baseUrl}/s/wide-open/`)).status, 200);
});

test('republishing does not silently change or reissue the password', async () => {
  const first = await publish({ slug: 'stable' });
  const password = structured(first.result).generated_password;

  const again = await publish({ slug: 'stable', html: '<p>v2</p>' });
  assert.equal(structured(again.result).generated_password, undefined, 'must not mint a second password');
  assert.equal(structured(again.result).visibility, 'password');

  const opened = await fetch(`${h.baseUrl}/s/stable/`, {
    headers: { authorization: 'Basic ' + Buffer.from(`:${password}`).toString('base64') },
  });
  assert.equal(opened.status, 200, 'the original password must still work');
  assert.match(await opened.text(), /v2/);
});

test('site_set_access refuses to open a site up without the acknowledgement', async () => {
  await publish({ slug: 'to-open' });
  const denied = await callTool(h.baseUrl, API_TOKEN, 'site_set_access', {
    slug: 'to-open', visibility: 'public',
  });
  assert.equal(denied.result.isError, true);
  assert.match(textOf(denied.result), /confirm_public/);
  assert.equal(
    structured((await callTool(h.baseUrl, API_TOKEN, 'site_get', { slug: 'to-open' })).result).visibility,
    'password',
    'the site must still be protected after a refused attempt',
  );

  const allowed = await callTool(h.baseUrl, API_TOKEN, 'site_set_access', {
    slug: 'to-open', visibility: 'public', confirm_public: true,
  });
  assert.equal(structured(allowed.result).visibility, 'public');
});

test('locking a public site back down mints a password when none is given', async () => {
  await publish({ slug: 'relock', visibility: 'public', confirm_public: true });
  const { result } = await callTool(h.baseUrl, API_TOKEN, 'site_set_access', {
    slug: 'relock', visibility: 'password',
  });
  const password = structured(result).generated_password;
  assert.ok(password, 'expected a minted password');
  const opened = await fetch(`${h.baseUrl}/s/relock/`, {
    headers: { authorization: 'Basic ' + Buffer.from(`:${password}`).toString('base64') },
  });
  assert.equal(opened.status, 200);
});

test('disabled needs no acknowledgement — it is not an exposure', async () => {
  const { result } = await publish({ slug: 'hidden', visibility: 'disabled' });
  assert.notEqual(result.isError, true, textOf(result));
  assert.equal(structured(result).visibility, 'disabled');
});

test('minted passwords are readable and unambiguous', async () => {
  const seen = new Set<string>();
  for (const slug of ['mint-a', 'mint-b', 'mint-c']) {
    const password = structured((await publish({ slug })).result).generated_password as string;
    // No characters that get confused when read aloud or retyped.
    assert.doesNotMatch(password, /[lo01]/, `${password} contains a look-alike character`);
    assert.match(password, /^[a-z2-9]+(-[a-z2-9]+)+$/, `${password} should be grouped and typeable`);
    seen.add(password);
  }
  assert.equal(seen.size, 3, 'each site must get its own password');
});
