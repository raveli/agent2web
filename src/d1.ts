import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

/**
 * A thin wrapper over D1.
 *
 * Not an abstraction layer — there is only one database and there will only ever
 * be one. It exists because `db.prepare(sql).bind(...).all()` repeated across
 * sixty call sites reads worse than `db.all(sql, ...params)`, and because
 * `batch()` deserves a name that says what it guarantees.
 */
export class Sql {
  constructor(private readonly db: D1Database) {}

  async all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    const { results } = await this.bind(sql, params).all<T>();
    return results;
  }

  async first<T>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    return (await this.bind(sql, params).first<T>()) ?? undefined;
  }

  async run(sql: string, ...params: unknown[]): Promise<void> {
    await this.bind(sql, params).run();
  }

  /**
   * Applies every statement or none of them.
   *
   * D1 offers no interactive transaction, which is enough here: every atomic
   * sequence agent2web needs is decided before the first write — publishing a
   * version, issuing a token pair, approving an authorization request.
   */
  async batch(statements: Statement[]): Promise<void> {
    if (statements.length === 0) return;
    await this.db.batch(statements.map(s => this.bind(s.sql, s.params ?? [])));
  }

  private bind(sql: string, params: unknown[]): D1PreparedStatement {
    const prepared = this.db.prepare(sql);
    return params.length ? prepared.bind(...params) : prepared;
  }
}

export type Statement = { sql: string; params?: unknown[] };

export const stmt = (sql: string, ...params: unknown[]): Statement => ({ sql, params });
