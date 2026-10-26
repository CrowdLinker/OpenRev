import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configPath, main, parseLogLine } from "../packages/openrev/index.mjs";
import { createApp } from "../src/server/app";
import type { Runtime } from "../src/server/context";
import { ingestEvent } from "../src/server/services/ingest";
import { recordPayment } from "../src/server/services/payments";
import { getSite } from "../src/server/services/sites";
import { testRuntime } from "./helpers";

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot";

describe("openrev CLI", () => {
  let rt: Runtime;
  let app: ReturnType<typeof createApp>;
  let home = "";
  let key = "";
  let accountKey = "";
  let siteId = "";

  /** Runs the CLI against the app in this process, as if OpenRev were at https://openrev.test. */
  const cli = async (argv: string[], env: Record<string, string> = {}) => {
    let stdout = "";
    let stderr = "";
    const code = await main(argv, {
      fetch: ((input: string, init?: RequestInit) => app.request(input, init)) as typeof fetch,
      stdout: { write: (s: string) => (stdout += s), isTTY: false, columns: 120 },
      stderr: { write: (s: string) => (stderr += s) },
      env: { XDG_CONFIG_HOME: join(home, "config"), ...env },
      home,
    });
    return { code, stdout, stderr };
  };

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "openrev-cli-"));
    rt = await testRuntime();
    app = createApp(() => rt);
    let cookie = "";
    const call = async (path: string, body?: unknown) => {
      const res = await app.request("http://openrev.test" + path, {
        method: body ? "POST" : "GET",
        headers: { "User-Agent": CHROME, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const sc = res.headers.get("set-cookie");
      if (sc?.startsWith("openrev_auth=")) cookie = sc.split(";")[0];
      return res.json();
    };
    await call("/api/auth/signup", { email: "owner@example.com", password: "supersecret" });
    siteId = (await call("/api/sites", { domain: "example.com", timezone: "UTC", currency: "USD" })).site.id;
    await call("/api/sites", { domain: "other.example", timezone: "UTC", currency: "EUR" });
    key = (await call(`/api/sites/${siteId}/keys`, { name: "cli" })).key;
    accountKey = (await call("/api/account/tokens", { name: "cli" })).key;

    const meta = { ip: "1.2.3.4", userAgent: CHROME, geo: { country: "CA", city: "Toronto" } };
    await ingestEvent(rt, { type: "pageview", websiteId: siteId, href: "https://example.com/pricing", referrer: "https://news.ycombinator.com/", visitorId: "visitor-cli-0001", sessionId: "session-cli-0001" }, meta);
    await ingestEvent(rt, { type: "pageview", websiteId: siteId, href: "https://example.com/", referrer: "https://www.google.com/", visitorId: "visitor-cli-0002", sessionId: "session-cli-0002" }, { ...meta, ip: "5.6.7.8" });
    await ingestEvent(rt, { type: "goal", websiteId: siteId, href: "https://example.com/pricing", name: "signup", visitorId: "visitor-cli-0001", sessionId: "session-cli-0001" }, meta);
    const site = (await getSite(rt.db, siteId))!;
    await recordPayment(rt, site, { provider: "stripe", transactionId: "pi_cli_1", type: "new", amount: 4900, currency: "USD", visitorId: "visitor-cli-0001", email: "ada@example.com", name: "Ada" });
  });

  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("parses access log lines", () => {
    expect(parseLogLine(`1.2.3.4 - - [26/Oct/2026:09:12:00 +0000] "GET /pricing?x=1 HTTP/1.1" 200 5120 "-" "${GPTBOT}"`)).toEqual({
      path: "/pricing?x=1",
      user_agent: GPTBOT,
      timestamp: Date.UTC(2026, 9, 26, 9, 12),
    });
    expect(parseLogLine("garbage")).toBeNull();
    expect(configPath({ XDG_CONFIG_HOME: "/x" })).toBe(join("/x", "openrev", "config.json"));
  });

  it("asks to log in, then saves the address and key privately", async () => {
    const before = await cli(["stats"]);
    expect(before.code).toBe(1);
    expect(before.stderr).toContain('Run "openrev login" first');

    const bad = await cli(["login", "--url", "https://openrev.test", "--key", "or_wrong"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/Invalid|invalid/);

    const ok = await cli(["login", "--url", "https://openrev.test/", "--key", key]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("example.com");
    const file = join(home, "config", "openrev", "config.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ url: "https://openrev.test", key });
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o077).toBe(0);
  });

  it("shows the overview, top reports, live visitors and payments", async () => {
    const stats = await cli(["stats", "--period", "today"]);
    expect(stats.code).toBe(0);
    expect(stats.stdout).toContain("example.com");
    expect(stats.stdout).toMatch(/Visitors\s+2/);
    expect(stats.stdout).toMatch(/Revenue\s+\$49\.00/);
    expect(stats.stdout).toMatch(/Customers\s+1/);

    const top = await cli(["top", "referrers", "-p", "today", "--by", "revenue"]);
    expect(top.code).toBe(0);
    const lines = top.stdout.split("\n").filter((l) => l.includes("Hacker News") || l.includes("Google"));
    expect(lines[0]).toContain("Hacker News");
    expect(lines[0]).toContain("$49");

    expect((await cli(["top", "nonsense"])).stderr).toContain("Pick a report");
    const goals = await cli(["top", "goals", "-p", "today"]);
    expect(goals.stdout).toMatch(/signup\s.*1/);

    const live = await cli(["live"]);
    expect(live.stdout).toMatch(/2 visitors online/);
    expect(live.stdout).toContain("/pricing");
    expect(live.stdout).toContain("Ada");

    const pays = await cli(["payments", "-p", "today"]);
    expect(pays.stdout).toContain("$49.00");
    expect(pays.stdout).toContain("Hacker News");

    const json = await cli(["stats", "--json", "-p", "today"]);
    expect(JSON.parse(json.stdout).overview.data.visitors).toBe(2);

    for (const cmd of ["mrr", "keywords", "social", "crawlers", "sites"]) {
      const r = await cli([cmd]);
      expect(r.code, `${cmd}: ${r.stderr}`).toBe(0);
    }
  });

  it("sends the crawler requests in an access log", async () => {
    const log = join(home, "access.log");
    const now = new Date();
    const stamp = `${String(now.getUTCDate()).padStart(2, "0")}/${now.toLocaleString("en", { month: "short", timeZone: "UTC" })}/${now.getUTCFullYear()}:${now.toISOString().slice(11, 19)} +0000`;
    await writeFile(
      log,
      [
        `1.2.3.4 - - [${stamp}] "GET /pricing HTTP/1.1" 200 512 "-" "${GPTBOT}"`,
        `1.2.3.4 - - [${stamp}] "GET /docs HTTP/1.1" 200 512 "-" "${GPTBOT}"`,
        `5.6.7.8 - - [${stamp}] "GET / HTTP/1.1" 200 512 "-" "${CHROME}"`,
        `5.6.7.8 - - [${stamp}] "POST /api HTTP/1.1" 200 512 "-" "${GPTBOT}"`,
        "not a log line",
      ].join("\n"),
    );
    const dry = await cli(["crawls", "send", log, "--dry-run"]);
    expect(dry.stdout).toContain("5 lines, 2 from crawlers");
    expect(dry.stdout).toContain("Dry run");
    const sent = await cli(["crawls", "send", log]);
    expect(sent.code).toBe(0);
    expect(sent.stdout).toContain("2 recorded");
    const report = await cli(["crawlers", "-p", "today"]);
    expect(report.stdout).toMatch(/GPTBot\s+OpenAI\s+AI training\s+2\s+2/);
    expect((await cli(["crawls", "send", join(home, "missing.log")])).stderr).toContain("Can't read");
  });

  it("asks which website when a key reads several", async () => {
    expect(accountKey).toMatch(/^ort_/);
    const env = { OPENREV_URL: "https://openrev.test", OPENREV_API_KEY: accountKey };
    expect((await cli(["stats"], env)).stderr).toContain("pick one with --site");
    const r = await cli(["stats", "--site", "other.example", "-p", "today"], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("other.example");
  });
});
