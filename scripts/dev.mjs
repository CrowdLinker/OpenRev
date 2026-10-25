// Development: rebuilds the server & tracker on change and runs Vite with HMR.
//   npm run dev   → dashboard on http://localhost:5173 (API proxied to :3000)
import { spawn } from "node:child_process";
import { context } from "esbuild";

const procs = [];
const start = (cmd, args, env = {}) => {
  const p = spawn(cmd, args, { stdio: "inherit", env: { ...process.env, ...env }, shell: process.platform === "win32" });
  procs.push(p);
  return p;
};

const server = await context({
  entryPoints: ["src/runtime/node.ts"],
  outfile: "dist/server/node.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: true,
});
await server.rebuild();
await server.watch();

start("node", ["scripts/build-tracker.mjs", "--watch"]);
start("node", ["--watch", "--env-file-if-exists=.env", "dist/server/node.js"], { PORT: process.env.PORT || "3000", GEOIP_AUTO_DOWNLOAD: process.env.GEOIP_AUTO_DOWNLOAD || "false" });
start("npx", ["vite"]);

const stop = () => {
  for (const p of procs) p.kill();
  server.dispose();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
