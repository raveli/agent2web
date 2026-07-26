import type { Sql } from '../d1.js';

/**
 * Fixed-window attempt limiter shared by every credential surface: admin login,
 * OAuth owner login, and per-site password prompts.
 *
 * It lives in the database rather than in memory. The old in-memory version was
 * fine for a single Node process but would be a no-op on Cloudflare, where each
 * isolate has its own heap and an attacker's requests spread across many of
 * them — the limiter would appear to work and stop nothing. Writes only happen
 * on failures, which are rare, so the cost is negligible; surviving a restart is
 * a bonus on the Node side.
 */
export class Throttle {
  constructor(
    private readonly db: Sql,
    private readonly limit: number,
    private readonly windowMs: number,
    /** Distinguishes limiters sharing the table, e.g. 'admin' vs 'site'. */
    private readonly scope: string,
  ) {}

  /** Seconds the caller must wait, or 0 when the attempt is allowed. */
  async check(key: string, now = Date.now()): Promise<number> {
    const row = await this.db.first<{ count: number; expires_at: number }>(
      'SELECT count, expires_at FROM login_attempts WHERE key = ?',
      this.key(key),
    );
    if (!row || row.expires_at <= now) return 0;
    if (row.count < this.limit) return 0;
    return Math.max(1, Math.ceil((row.expires_at - now) / 1000));
  }

  async fail(key: string, now = Date.now()): Promise<void> {
    // One statement so concurrent failures cannot lose a count: the window is
    // restarted only when the stored one has already expired.
    await this.db.run(
      `INSERT INTO login_attempts (key, count, expires_at) VALUES (?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE WHEN login_attempts.expires_at <= ? THEN 1 ELSE login_attempts.count + 1 END,
           expires_at = CASE WHEN login_attempts.expires_at <= ? THEN ? ELSE login_attempts.expires_at END`,
      this.key(key),
      now + this.windowMs,
      now,
      now,
      now + this.windowMs,
    );
  }

  async succeed(key: string): Promise<void> {
    await this.db.run('DELETE FROM login_attempts WHERE key = ?', this.key(key));
  }

  private key(key: string): string {
    return `${this.scope}:${key}`;
  }
}

/** Drops expired windows; called from the periodic purge. */
export async function purgeAttempts(db: Sql, now = Date.now()): Promise<void> {
  await db.run('DELETE FROM login_attempts WHERE expires_at <= ?', now);
}
