#!/usr/bin/env node
// OpenRev setup wizard — deploys OpenRev to Cloudflare, Docker or Node.js.
//
//   npm run setup                         (interactive)
//   npm run setup -- --target cloudflare  (non-interactive where possible)
//   npm run setup -- --target docker --url https://analytics.example.com
//
// No dependencies: runs right after cloning the repository.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { ReadStream } from "node:tty";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : "true";
};
const yes = flag("yes") === "true";

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[22m`,
  dim: (s) => `\x1b[2m${s}\x1b[22m`,
  green: (s) => `\x1b[32m${s}\x1b[39m`,
  violet: (s) => `\x1b[35m${s}\x1b[39m`,
  red: (s) => `\x1b[31m${s}\x1b[39m`,
  yellow: (s) => `\x1b[33m${s}\x1b[39m`,
};
const log = (...m) => console.log(...m);
const step = (m) => log(`\n${c.violet("◆")} ${c.bold(m)}`);
const ok = (m) => log(`${c.green("✔")} ${m}`);
const warn = (m) => log(`${c.yellow("!")} ${m}`);
const die = (m) => {
  log(`\n${c.red("✖")} ${m}`);
  process.exit(1);
};

let rl = null;
function prompt() {
  if (!rl) {
    let input = process.stdin;
    // When piped through `curl | bash`, read answers from the terminal.
    if (!process.stdin.isTTY) {
      try {
        input = new ReadStream(openSync("/dev/tty", "r"));
      } catch {
        input = process.stdin;
      }
    }
    rl = createInterface({ input, output: process.stdout });
  }
  return rl;
}

async function ask(question, def) {
  if (yes && def !== undefined) return def;
  const answer = (await prompt().question(`${c.violet("?")} ${question}${def ? c.dim(` (${def})`) : ""} `)).trim();
  return answer || def || "";
}

async function choose(question, options, def = 0) {
  if (yes) return options[def].value;
  log(`${c.violet("?")} ${question}`);
  options.forEach((o, i) => log(`  ${c.bold(String(i + 1))}) ${o.label}${o.hint ? c.dim(` — ${o.hint}`) : ""}`));
  const answer = await ask("Choose", String(def + 1));
  const idx = Number(answer) - 1;
  return (options[idx] ?? options[def]).value;
}

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    // stdin is piped only when we feed it (e.g. `wrangler secret put`); otherwise the user's terminal is inherited.
    const stdin = opts.input !== undefined ? "pipe" : "inherit";
    const child = spawn(cmd, cmdArgs, {
      stdio: opts.capture ? [stdin, "pipe", "pipe"] : [stdin, "inherit", "inherit"],
      shell: process.platform === "win32",
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    let out = "";
    if (opts.capture) {
      child.stdout.on("data", (d) => {
        out += d;
        process.stdout.write(d);
      });
      child.stderr.on("data", (d) => {
        out += d;
        process.stderr.write(d);
      });
    }
    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input);
    }
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${cmdArgs.join(" ")} exited with code ${code}`))));
  });
}

function has(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
  return r.status === 0;
}

function saveState(state) {
  writeFileSync(".openrev.json", JSON.stringify(state, null, 2) + "\n");
}
function loadState() {
  try {
    return JSON.parse(readFileSync(".openrev.json", "utf8"));
  } catch {
    return {};
  }
}

const secret = () => randomBytes(32).toString("hex");

// ---------------------------------------------------------------------------

async function ensureDeps() {
  if (!existsSync("node_modules")) {
    step("Installing dependencies");
    await run("npm", ["install", "--no-audit", "--no-fund"]);
  }
}

async function cloudflare(state) {
  step("Deploying to Cloudflare Workers + D1");
  log(c.dim("Free tier friendly: Workers (100k requests/day) and D1 (5 GB). Analytics data stays in your own Cloudflare account."));
  await ensureDeps();

  const who = spawnSync("npx", ["wrangler", "whoami"], { encoding: "utf8", shell: process.platform === "win32" });
  if (!/associated with the email|You are logged in/i.test(`${who.stdout}${who.stderr}`)) {
    step("Log in to Cloudflare (a browser window will open)");
    await run("npx", ["wrangler", "login"]);
  } else {
    ok("Logged in to Cloudflare");
  }

  const name = flag("name") ?? state.name ?? (await ask("Worker name", "openrev"));
  if (!/^[a-z0-9-]{1,63}$/.test(name)) die("The name can only contain lowercase letters, numbers and dashes.");

  // Point wrangler.jsonc at the chosen worker name.
  const wranglerPath = "wrangler.jsonc";
  const config = readFileSync(wranglerPath, "utf8");
  if (!config.includes(`"name": "${name}"`)) writeFileSync(wranglerPath, config.replace(/"name":\s*"[^"]*"/, `"name": "${name}"`));

  step("Building the dashboard and tracking script");
  await run("npm", ["run", "build:client"]);

  step("Deploying (the D1 database is created automatically on the first deploy)");
  const out = await run("npx", ["wrangler", "deploy"], { capture: true });
  const url = out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0] ?? state.url;

  if (!state.secretSet) {
    step("Storing an encryption secret for payment provider credentials");
    await run("npx", ["wrangler", "secret", "put", "OPENREV_SECRET"], { input: secret() + "\n" });
    state.secretSet = true;
  }

  saveState({ ...state, target: "cloudflare", name, url });
  done(url ?? "your workers.dev URL (shown above)", [
    `Add a custom domain: Cloudflare dashboard → Workers & Pages → ${name} → Settings → Domains & Routes`,
    `Update later with: ${c.bold("npm run update")}`,
  ]);
}

async function docker(state) {
  step("Running OpenRev with Docker");
  if (!has("docker")) die("Docker is not installed. Get it from https://docs.docker.com/get-docker/ (or choose Node.js).");
  const url = flag("url") ?? state.url ?? (await ask("Public URL of your OpenRev instance", "http://localhost:3000"));
  const port = flag("port") ?? state.port ?? (await ask("Port", "3000"));
  const db = flag("db") ?? state.db ?? (await choose("Database", [
    { value: "sqlite", label: "SQLite", hint: "zero setup, great up to millions of events/month" },
    { value: "postgres", label: "PostgreSQL", hint: "bundled Postgres container" },
  ]));
  const env = readEnv();
  env.PUBLIC_URL = url;
  env.PORT = port;
  env.OPENREV_SECRET ||= secret();
  if (db === "postgres") env.POSTGRES_PASSWORD ||= randomBytes(16).toString("hex");
  writeEnv(env);
  ok("Wrote .env");
  const file = db === "postgres" ? "docker-compose.postgres.yml" : "docker-compose.yml";
  step("Starting containers");
  await run("docker", ["compose", "-f", file, "up", "-d", "--build"]);
  saveState({ ...state, target: "docker", url, port, db });
  done(url, [`Logs: docker compose -f ${file} logs -f`, `Update later with: ${c.bold("npm run update")}`, "Put it behind HTTPS (Caddy, Nginx, Cloudflare Tunnel...) before going live — see docs/self-hosting/docker.md"]);
}

async function node(state) {
  step("Running OpenRev with Node.js");
  const major = Number(process.versions.node.split(".")[0]);
  const minor = Number(process.versions.node.split(".")[1]);
  if (major < 22 || (major === 22 && minor < 13)) die(`Node.js 22.13+ is required (you have ${process.versions.node}).`);
  const url = flag("url") ?? state.url ?? (await ask("Public URL of your OpenRev instance", "http://localhost:3000"));
  const port = flag("port") ?? state.port ?? (await ask("Port", "3000"));
  const databaseUrl = flag("database-url") ?? state.databaseUrl ?? (await ask("Database (SQLite file path or postgres:// URL)", "./data/openrev.db"));
  const env = readEnv();
  env.PUBLIC_URL = url;
  env.PORT = port;
  env.DATABASE_URL = databaseUrl;
  env.OPENREV_SECRET ||= secret();
  writeEnv(env);
  ok("Wrote .env");
  await ensureDeps();
  step("Building");
  await run("npm", ["run", "build"]);
  saveState({ ...state, target: "node", url, port, databaseUrl });
  const start = flag("start") ?? (yes ? "false" : (await ask("Start OpenRev now? (y/n)", "y")).toLowerCase().startsWith("y") ? "true" : "false");
  done(url, [`Start: ${c.bold("npm start")} (reads .env)`, "Keep it running with systemd or pm2 — see docs/self-hosting/node.md", `Update later with: ${c.bold("npm run update")}`]);
  if (start === "true") await run("node", ["--env-file=.env", "dist/server/node.js"]);
}

function readEnv() {
  const env = {};
  if (existsSync(".env")) {
    for (const line of readFileSync(".env", "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
  }
  return env;
}
function writeEnv(env) {
  writeFileSync(".env", Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
}

function done(url, tips) {
  log(`\n${c.green("━".repeat(60))}`);
  log(`${c.green("✔")} ${c.bold("OpenRev is ready!")}`);
  log(`\n  Open ${c.bold(c.violet(url))} and create your admin account.`);
  log(`  Then add your website and paste the tracking script into your site's <head>.\n`);
  for (const t of tips) log(`  ${c.dim("•")} ${t}`);
  log(`${c.green("━".repeat(60))}\n`);
}

async function update() {
  const state = loadState();
  if (!state.target) die("No previous setup found (.openrev.json). Run `npm run setup` first.");
  step("Updating OpenRev");
  if (existsSync(".git")) await run("git", ["pull", "--ff-only"]).catch(() => warn("git pull failed — continuing with the current code"));
  await run("npm", ["install", "--no-audit", "--no-fund"]);
  if (state.target === "cloudflare") {
    await run("npm", ["run", "build:client"]);
    await run("npx", ["wrangler", "deploy"]);
  } else if (state.target === "docker") {
    const file = state.db === "postgres" ? "docker-compose.postgres.yml" : "docker-compose.yml";
    await run("docker", ["compose", "-f", file, "up", "-d", "--build"]);
  } else {
    await run("npm", ["run", "build"]);
    warn("Restart your OpenRev process to apply the update.");
  }
  ok("Updated. Database migrations run automatically on start.");
}

async function main() {
  log(`\n  ${c.violet("▲")} ${c.bold("OpenRev")} ${c.dim("— open-source, revenue-first web analytics")}\n`);
  if (args[0] === "update") return update();
  const state = loadState();
  const target =
    flag("target") ??
    (await choose("Where do you want to run OpenRev?", [
      { value: "cloudflare", label: "Cloudflare", hint: "Workers + D1, serverless, free tier — recommended" },
      { value: "docker", label: "Docker", hint: "any VPS or server (Hetzner, DigitalOcean, Coolify...)" },
      { value: "node", label: "Node.js", hint: "run it directly on a machine" },
    ]));
  if (target === "cloudflare") await cloudflare(state);
  else if (target === "docker") await docker(state);
  else if (target === "node") await node(state);
  else die(`Unknown target "${target}". Use cloudflare, docker or node.`);
}

main()
  .catch((err) => die(err.message))
  .finally(() => rl?.close());
