/**
 * The database seen by everything above the driver layer.
 *
 * Both implementations speak SQLite — better-sqlite3 on Node, D1 on Cloudflare —
 * so the SQL itself is shared. Only the call shape differs, and it is async here
 * because D1 has no synchronous API.
 */
export interface Db {
  all<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  first<T>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  run(sql: string, ...params: unknown[]): Promise<void>;

  /**
   * Applies every statement atomically.
   *
   * D1 has no interactive transactions, so this is the only transaction
   * primitive available. It is enough: every transaction agent2web needs is a
   * pure sequence of writes decided in advance — publishing a version, issuing a
   * token pair, approving an authorization request.
   */
  batch(statements: Statement[]): Promise<void>;
}

export type Statement = { sql: string; params?: unknown[] };

export const stmt = (sql: string, ...params: unknown[]): Statement => ({ sql, params });
