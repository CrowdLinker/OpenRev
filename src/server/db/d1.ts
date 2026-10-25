import { normalizeParams, splitSql, type Database, type SqlValue, type Statement } from "./types";

/** The subset of the Cloudflare D1 binding API that OpenRev uses. */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = unknown>(): Promise<{ results: T[] }>;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<{ meta: { changes?: number } }>;
}

export interface D1DatabaseBinding {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
}

export function d1Database(d1: D1DatabaseBinding): Database {
  const prep = (sql: string, params?: SqlValue[]) => d1.prepare(sql).bind(...normalizeParams(params));
  return {
    dialect: "sqlite",
    async all<T>(sql: string, params?: SqlValue[]) {
      const res = await prep(sql, params).all<T>();
      return res.results ?? [];
    },
    async first<T>(sql: string, params?: SqlValue[]) {
      return (await prep(sql, params).first<T>()) ?? null;
    },
    async run(sql: string, params?: SqlValue[]) {
      const res = await prep(sql, params).run();
      return { changes: res.meta?.changes ?? 0 };
    },
    async batch(statements: Statement[]) {
      if (statements.length === 0) return;
      await d1.batch(statements.map((s) => prep(s.sql, s.params)));
    },
    async exec(sql: string) {
      const statements = splitSql(sql);
      if (statements.length === 0) return;
      await d1.batch(statements.map((s) => d1.prepare(s)));
    },
  };
}
