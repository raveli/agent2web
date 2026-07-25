/**
 * In-memory fixed-window attempt limiter shared by every credential surface
 * (admin login, OAuth owner login, per-site password prompts).
 *
 * Deliberately process-local: this app runs as a single replica because it owns
 * a SQLite database on a read-write-once volume.
 */
export class Throttle {
  #hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Returns the number of seconds to wait, or 0 when the attempt is allowed. */
  check(key: string, now = Date.now()): number {
    const entry = this.#hits.get(key);
    if (!entry || entry.resetAt <= now) return 0;
    if (entry.count < this.limit) return 0;
    return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  }

  fail(key: string, now = Date.now()): void {
    const entry = this.#hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.#hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    entry.count += 1;
  }

  succeed(key: string): void {
    this.#hits.delete(key);
  }

  /** Drops expired windows; called periodically so the map cannot grow forever. */
  sweep(now = Date.now()): void {
    for (const [key, entry] of this.#hits) {
      if (entry.resetAt <= now) this.#hits.delete(key);
    }
  }
}
