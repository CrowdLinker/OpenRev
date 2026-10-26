import { describe, expect, it, vi } from "vitest";
import { runScheduled } from "../src/server/services/scheduler";
import { testDb, testRuntime } from "./helpers";

// What each sync saw of the shared budget when it started. Each one then spends 500 statements.
const calls = vi.hoisted(() => [] as { job: string; left: number | undefined }[]);
const spend = (job: string) => async (_rt: unknown, _now: number, budget?: { left: number; wrote: boolean }) => {
  calls.push({ job, left: budget?.left });
  if (budget) {
    budget.left -= 500;
    budget.wrote = true;
  }
};

vi.mock("../src/server/services/search-console", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/services/search-console")>()),
  syncAllSearchConsole: (...args: [unknown, number, { left: number; wrote: boolean }?]) => spend("search-console")(...args),
}));
vi.mock("../src/server/services/social", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/services/social")>()),
  syncAllSocial: (...args: [unknown, number, { left: number; wrote: boolean }?]) => spend("social")(...args),
}));
vi.mock("../src/server/lib/currency", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/lib/currency")>()),
  getRates: async () => ({}),
}));

describe("scheduler", () => {
  it("gives the Search Console and social syncs one statement budget per run, and alternates which goes first", async () => {
    const rt = await testRuntime(await testDb());
    const t = 600_000 * 2_960_000; // the start of a 10-minute slot, at minute 0 so alerts don't run
    await runScheduled(rt, t);
    await runScheduled(rt, t + 600_000);
    expect(calls).toEqual([
      { job: "search-console", left: 600 },
      { job: "social", left: 100 },
      { job: "social", left: 600 },
      { job: "search-console", left: 100 },
    ]);
  });
});
