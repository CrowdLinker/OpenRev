// Builds the tracking script variants into dist/public/js.
import { build } from "esbuild";
import { mkdirSync, statSync } from "node:fs";

const watch = process.argv.includes("--watch");
const outdir = "dist/public/js";
mkdirSync(outdir, { recursive: true });

const variants = [
  { file: "script.js", hash: false, cookieless: false },
  { file: "script.hash.js", hash: true, cookieless: false },
  { file: "script.cookieless.js", hash: false, cookieless: true },
  { file: "script.hash.cookieless.js", hash: true, cookieless: true },
];

for (const v of variants) {
  const options = {
    entryPoints: ["src/tracker/script.ts"],
    outfile: `${outdir}/${v.file}`,
    bundle: true,
    minify: true,
    format: "iife",
    target: ["es2017"],
    define: { __HASH_MODE__: String(v.hash), __COOKIELESS__: String(v.cookieless) },
    legalComments: "none",
  };
  if (watch) {
    const { context } = await import("esbuild");
    const ctx = await context(options);
    await ctx.watch();
  } else {
    await build(options);
    console.log(`  ${outdir}/${v.file}  ${(statSync(`${outdir}/${v.file}`).size / 1024).toFixed(1)} kB`);
  }
}
if (watch) console.log("Watching tracker...");
