import { normalizeParams, type Database, type SqlValue, type Statement } from "./types";

/** Converts `?` placeholders to Postgres-style `$1, $2, ...`. */
export function toPostgresPlaceholders(sql: string): string {
  let i = 0;
  let out = "";
  let inString = false;
  for (const ch of sql) {
    if (ch === "'") inString = !inString;
    if (ch === "?" && !inString) {
      out += "$" + ++i;
    } else {
      out += ch;
    }
  }
  return out;
}

export async function postgresDatabase(url: string): Promise<Database> {
  const { default: postgres } = await import("postgres");
  const toNumber = (x: string) => (x === null ? null : Number(x));
  const sql = postgres(url, {
    max: Number(process.env.DATABASE_POOL_SIZE || 10),
    onnotice: () => {},
    ssl: /sslmode=(require|verify)/.test(url) ? "require" : undefined,
    types: {
      // Return BIGINT / NUMERIC values as JS numbers (analytics counts fit easily).
      bigint: { to: 20, from: [20], serialize: (x: unknown) => String(x), parse: toNumber },
      numeric: { to: 1700, from: [1700], serialize: (x: unknown) => String(x), parse: toNumber },
    } as never,
  });

  const run = async (q: { unsafe: typeof sql.unsafe }, text: string, params?: SqlValue[]) =>
    q.unsafe(toPostgresPlaceholders(text), normalizeParams(params) as never[]);

  return {
    dialect: "postgres",
    async all<T>(text: string, params?: SqlValue[]) {
      return (await run(sql, text, params)) as unknown as T[];
    },
    async first<T>(text: string, params?: SqlValue[]) {
      const rows = (await run(sql, text, params)) as unknown as T[];
      return rows[0] ?? null;
    },
    async run(text: string, params?: SqlValue[]) {
      const res = await run(sql, text, params);
      return { changes: res.count ?? 0 };
    },
    async batch(statements: Statement[]) {
      if (statements.length === 0) return;
      await sql.begin(async (tx) => {
        for (const s of statements) await run(tx as never, s.sql, s.params);
      });
    },
    async exec(text: string) {
      await sql.unsafe(text);
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}
