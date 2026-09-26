/**
 * Memoises an async initialiser until it succeeds.
 *
 * `x ??= init()` caches the promise, so a rejected one is returned to every
 * later caller: one transient failure then breaks each request until the
 * isolate is recycled. This forgets a failure, so the next call tries again.
 */
export function onceUntilSuccess<T>(init: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= init().catch(err => {
      pending = undefined;
      throw err;
    });
    return pending;
  };
}
