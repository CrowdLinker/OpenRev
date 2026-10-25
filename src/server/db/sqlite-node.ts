import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeParams, type Database, type SqlValue, type Statement } from "./types";

type StatementSync = {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint };
};

type DatabaseSync = {
  prepare(sql: string): StatementSync;
  exec(sql: string): void;
  close(): void;
};

/**
 * SQLite adapter backed by Node's built-in `node:sqlite` module (Node >= 22.13),
 * so no native dependencies need to be compiled.
 */
export async function nodeSqliteDatabase(path: string): Promise<Database> {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  // Silence the "SQLite is an experimental feature" warning on older Node versions.
  const originalEmit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const msg = typeof warning === "string" ? warning : warning?.message;
    if (msg && msg.includes("SQLite")) return;
    return (originalEmit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
    DatabaseSync: new (path: string) => DatabaseSync;
  };
  process.emitWarning = originalEmit;

  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");

  const cache = new Map<string, StatementSync>();
  const stmt = (sql: string) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      if (cache.size > 500) cache.clear();
      cache.set(sql, s);
    }
    return s;
  };

  return {
    dialect: "sqlite",
    async all<T>(sql: string, params?: SqlValue[]) {
      return stmt(sql).all(...normalizeParams(params)) as T[];
    },
    async first<T>(sql: string, params?: SqlValue[]) {
      return (stmt(sql).get(...normalizeParams(params)) as T | undefined) ?? null;
    },
    async run(sql: string, params?: SqlValue[]) {
      const res = stmt(sql).run(...normalizeParams(params));
      return { changes: Number(res.changes) };
    },
    async batch(statements: Statement[]) {
      if (statements.length === 0) return;
      db.exec("BEGIN");
      try {
        for (const s of statements) stmt(s.sql).run(...normalizeParams(s.params));
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    async exec(sql: string) {
      db.exec(sql);
    },
    async close() {
      db.close();
    },
  };
}
