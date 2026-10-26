import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/server/db/migrations";
import { toPostgresPlaceholders } from "../src/server/db/postgres";
import { normalizeParams, type Database, type SqlValue, type Statement } from "../src/server/db/types";

/**
 * In-process PostgreSQL (WASM) used to check that every query also runs on Postgres.
 * Mirrors the production adapter in src/server/db/postgres.ts (BIGINT/NUMERIC returned as numbers).
 * `migrate: false` leaves it empty, for upgrade tests that apply older migrations first.
 */
export async function pgliteDb(opts: { migrate?: boolean } = {}): Promise<Database> {
  const pg = new PGlite({
    parsers: {
      20: (v: string) => Number(v),
      1700: (v: string) => Number(v),
    },
  });
  const conv = (rows: Record<string, unknown>[]) => rows;
  const db: Database = {
    dialect: "postgres",
    async all<T>(sql: string, params?: SqlValue[]) {
      const r = await pg.query(toPostgresPlaceholders(sql), normalizeParams(params) as unknown[]);
      return conv(r.rows as Record<string, unknown>[]) as T[];
    },
    async first<T>(sql: string, params?: SqlValue[]) {
      const r = await pg.query(toPostgresPlaceholders(sql), normalizeParams(params) as unknown[]);
      return ((r.rows as T[])[0] ?? null) as T | null;
    },
    async run(sql: string, params?: SqlValue[]) {
      const r = await pg.query(toPostgresPlaceholders(sql), normalizeParams(params) as unknown[]);
      return { changes: r.affectedRows ?? 0 };
    },
    async batch(statements: Statement[]) {
      await pg.transaction(async (tx) => {
        for (const s of statements) await tx.query(toPostgresPlaceholders(s.sql), normalizeParams(s.params) as unknown[]);
      });
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
    async close() {
      await pg.close();
    },
  };
  if (opts.migrate !== false) await migrate(db);
  return db;
}
