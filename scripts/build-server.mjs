// Bundles the Node.js server into dist/server/node.js (dependencies stay external).
import { build } from "esbuild";

await build({
  entryPoints: ["src/runtime/node.ts"],
  outfile: "dist/server/node.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: true,
  banner: { js: "// OpenRev server — https://github.com/CrowdLinker/OpenRev" },
});
console.log("  dist/server/node.js");
