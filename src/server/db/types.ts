export type SqlValue = string | number | bigint | boolean | null | undefined;

export interface Statement {
  sql: string;
  params?: SqlValue[];
}

/**
 * Minimal database abstraction shared by every runtime.
 *
 * SQL is written once using `?` placeholders and a portable subset of SQL that
 * works on SQLite (Cloudflare D1, node:sqlite, libSQL) and PostgreSQL.
 */
export interface Database {
  readonly dialect: "sqlite" | "postgres";
  all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T | null>;
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
  /** Runs statements atomically (in a transaction where the driver supports it). */
  batch(statements: Statement[]): Promise<void>;
  /** Executes one or more statements without parameters (used for migrations). */
  exec(sql: string): Promise<void>;
  close?(): Promise<void>;
}

export function normalizeParams(params: SqlValue[] = []): (string | number | bigint | null)[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    return p;
  });
}

/** Splits a SQL script into individual statements (no support for semicolons inside strings). */
export function splitSql(script: string): string[] {
  return script
    .replace(/--.*$/gm, "")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim().replace(/;$/, ""))
    .filter((s) => s.length > 0);
}
