import type { Runtime } from "../src/server/context";
import { migrate } from "../src/server/db/migrations";
import { nodeSqliteDatabase } from "../src/server/db/sqlite-node";
import { postgresDatabase } from "../src/server/db/postgres";
import type { Database } from "../src/server/db/types";

/** A real PostgreSQL server (CI sets TEST_DATABASE_URL); each call gets an isolated schema. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export async function realPostgresDb(): Promise<Database> {
  const schema = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = await postgresDatabase(TEST_DATABASE_URL!);
  await admin.exec(`CREATE SCHEMA ${schema}`);
  await admin.close?.();
  const db = await postgresDatabase(TEST_DATABASE_URL!, { schema });
  await migrate(db);
  return db;
}

/** Creates an in-memory SQLite database with the full schema applied. */
export async function testDb(): Promise<Database> {
  const db = await nodeSqliteDatabase(":memory:");
  await migrate(db);
  return db;
}

export async function testRuntime(db?: Database): Promise<Runtime> {
  const database = db ?? (await testDb());
  const pending: Promise<unknown>[] = [];
  return {
    platform: "node",
    db: database,
    config: { secret: "test-secret" },
    waitUntil: (p) => {
      pending.push(p.catch(() => {}));
    },
  };
}
