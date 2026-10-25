import type { Runtime } from "../src/server/context";
import { migrate } from "../src/server/db/migrations";
import { nodeSqliteDatabase } from "../src/server/db/sqlite-node";
import type { Database } from "../src/server/db/types";

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
