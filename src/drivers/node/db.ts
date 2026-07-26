import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Db, Statement } from '../../ports/db.js';

/**
 * better-sqlite3 behind the async Db port.
 *
 * The driver is synchronous underneath; the promises are immediate. That costs
 * nothing and lets every caller above this layer be written once for both
 * runtimes, since D1 has no synchronous API.
 */
export class NodeDb implements Db {
  constructor(private readonly db: Database.Database) {}

  static open(path: string): NodeDb {
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    return new NodeDb(db);
  }

  async all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  async first<T>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    return this.db.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  async run(sql: string, ...params: unknown[]): Promise<void> {
    this.db.prepare(sql).run(...(params as never[]));
  }

  async batch(statements: Statement[]): Promise<void> {
    const tx = this.db.transaction((list: Statement[]) => {
      for (const s of list) this.db.prepare(s.sql).run(...((s.params ?? []) as never[]));
    });
    tx(statements);
  }

  /** Escape hatch for schema application and pragmas; Node driver only. */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(source: string): unknown {
    return this.db.pragma(source, { simple: true });
  }

  close(): void {
    this.db.close();
  }
}
