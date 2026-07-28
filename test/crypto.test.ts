import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { WebCryptoProvider, parsePbkdf2 } from '../src/core/crypto.js';

/**
 * The Cloudflare iteration cap.
 *
 * Production Workers refuse a PBKDF2 derivation above 100,000 iterations:
 *
 *   NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
 *   supported (requested 600000).
 *
 * The trap is that this limit does not exist anywhere we can run a test.
 * workerd removed its own default in commit 12bc98a9 ("Removes the limit for
 * workerd by default"), so `wrangler dev`, Miniflare and this suite all have no
 * cap, and only the closed-source production enforcer keeps one. A deployment
 * can therefore be broken while every test is green — which is exactly how this
 * shipped.
 *
 * So the invariant is asserted here, against the runtime call itself, rather
 * than left to a runtime that will never complain.
 */
const CLOUDFLARE_MAX_PBKDF2_ITERATIONS = 100_000;

/** Records the iteration count of every PBKDF2 derivation made inside `body`. */
async function iterationCounts(body: () => Promise<unknown>): Promise<number[]> {
  const subtle = globalThis.crypto.subtle;
  const original = subtle.deriveBits.bind(subtle) as (...args: any[]) => Promise<ArrayBuffer>;
  const seen: number[] = [];
  (subtle as any).deriveBits = (algorithm: any, ...rest: any[]) => {
    if (algorithm?.name === 'PBKDF2') seen.push(algorithm.iterations);
    return original(algorithm, ...rest);
  };
  try {
    await body();
  } finally {
    (subtle as any).deriveBits = original;
  }
  return seen;
}

const crypto = new WebCryptoProvider();

test('no single derivation exceeds what Cloudflare will run', async () => {
  const hashing = await iterationCounts(() => crypto.hashPassword('a-good-admin-password'));
  assert.ok(hashing.length > 0, 'no PBKDF2 derivation was observed — the spy missed it');
  for (const iterations of hashing) {
    assert.ok(
      iterations <= CLOUDFLARE_MAX_PBKDF2_ITERATIONS,
      `hashPassword asked for ${iterations} iterations in one call; production Workers reject anything above ${CLOUDFLARE_MAX_PBKDF2_ITERATIONS}`,
    );
  }

  const stored = await crypto.hashPassword('a-good-admin-password');
  const verifying = await iterationCounts(() =>
    crypto.verifyPassword('a-good-admin-password', stored),
  );
  assert.ok(verifying.length > 0);
  for (const iterations of verifying) {
    assert.ok(
      iterations <= CLOUDFLARE_MAX_PBKDF2_ITERATIONS,
      `verifyPassword asked for ${iterations} iterations in one call; production Workers reject anything above ${CLOUDFLARE_MAX_PBKDF2_ITERATIONS}`,
    );
  }
});

test('the total work still meets the OWASP floor of 600k', async () => {
  const counts = await iterationCounts(() => crypto.hashPassword('a-good-admin-password'));
  const total = counts.reduce((n, c) => n + c, 0);
  assert.equal(total, 600_000, 'an attacker must still do 600k iterations per guess');
});

test('a password round-trips, and a wrong one does not', async () => {
  const stored = await crypto.hashPassword('correct-horse-battery');
  assert.equal(await crypto.verifyPassword('correct-horse-battery', stored), true);
  assert.equal(await crypto.verifyPassword('correct-horse-batteru', stored), false);
  assert.equal(await crypto.verifyPassword('', stored), false);
});

test('hashing the same password twice gives different stored values', async () => {
  const a = await crypto.hashPassword('correct-horse-battery');
  const b = await crypto.hashPassword('correct-horse-battery');
  assert.notEqual(a, b, 'the salt is not random');
});

test('a hash from the uncapped single-call scheme is refused, not silently wrong', async () => {
  // Hashes minted before the cap was discovered ran 600k in one derivation.
  // Chunked verification of one of those produces a different key, so treating
  // it as valid input would reject the owner's real password with "Incorrect
  // credentials" and no explanation. It has to be unverifiable instead, which
  // is what loadConfig turns into a startup error naming the variable.
  const legacy = 'pbkdf2.600000.c2FsdHNhbHRzYWx0c2E.a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5aTQ';
  assert.equal(crypto.canVerify(legacy), false);
  assert.equal(parsePbkdf2(legacy), undefined);
  assert.equal(await crypto.verifyPassword('anything', legacy), false);
});

test('a current hash is self-describing and verifiable', async () => {
  const stored = await crypto.hashPassword('a-good-admin-password');
  assert.equal(crypto.canVerify(stored), true);
  const parsed = parsePbkdf2(stored);
  assert.ok(parsed);
  assert.ok(
    parsed.chunk <= CLOUDFLARE_MAX_PBKDF2_ITERATIONS,
    'the stored chunk size must be runnable on Cloudflare',
  );
  assert.equal(parsed.chunk * parsed.rounds, 600_000);
});

test('garbage never verifies and never throws', async () => {
  for (const bad of ['', 'nonsense', 'pbkdf2', 'pbkdf2c.100000.6.@@@.@@@', 'pbkdf2c.0.6.aa.bb']) {
    assert.equal(crypto.canVerify(bad), false, bad);
    assert.equal(await crypto.verifyPassword('x', bad), false, bad);
  }
});
