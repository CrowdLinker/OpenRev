// Builds the tracking script variants and the live badge into dist/public/js.
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
  await run(options, v.file);
}

// The embeddable live badge (<openrev-badge>), served next to the tracker.
await run(
  { entryPoints: ["src/tracker/badge.ts"], outfile: `${outdir}/badge.js`, bundle: true, minify: true, format: "iife", target: ["es2017"], legalComments: "none" },
  "badge.js",
);

async function run(options, file) {
  if (watch) {
    const { context } = await import("esbuild");
    const ctx = await context(options);
    await ctx.watch();
  } else {
    await build(options);
    console.log(`  ${outdir}/${file}  ${(statSync(`${outdir}/${file}`).size / 1024).toFixed(1)} kB`);
  }
}
if (watch) console.log("Watching tracker...");
