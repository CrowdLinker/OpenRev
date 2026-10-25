#!/usr/bin/env node
// npm create openrev@latest [folder] [-- --target cloudflare|docker|node]
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO = process.env.OPENREV_REPO || "https://github.com/CrowdLinker/OpenRev.git";
const BRANCH = process.env.OPENREV_BRANCH || "main";
const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`Usage: npm create openrev@latest [folder] [-- --target cloudflare|docker|node] [--name <name>] [--yes]

Downloads OpenRev into ./[folder] (default: openrev), installs its dependencies and runs the setup wizard.
Docs: https://github.com/CrowdLinker/OpenRev#-quick-start`);
  process.exit(0);
}
const dir = argv[0] && !argv[0].startsWith("-") ? argv.shift() : "openrev";
const target = resolve(dir);

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });
  if (r.status !== 0) {
    console.error(`\n✖ ${cmd} ${args.join(" ")} failed`);
    process.exit(r.status ?? 1);
  }
};

console.log("\n  ▲ OpenRev — open-source, revenue-first web analytics\n");
if (spawnSync("git", ["--version"], { stdio: "ignore" }).status !== 0) {
  console.error("✖ git is required: https://git-scm.com/downloads");
  process.exit(1);
}
if (existsSync(resolve(target, ".git"))) {
  console.log(`◆ Updating ${dir}`);
  run("git", ["-C", target, "pull", "--ff-only"]);
} else {
  console.log(`◆ Downloading OpenRev into ./${dir}`);
  run("git", ["clone", "--depth", "1", "--branch", BRANCH, REPO, target]);
}
console.log("◆ Installing dependencies");
run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: target });
run("node", ["scripts/setup.mjs", ...argv], { cwd: target });
