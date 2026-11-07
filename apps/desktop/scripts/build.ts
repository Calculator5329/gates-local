// Bundles Electron main and the sandboxed preload to apps/desktop/out/.
// Run: node scripts/build.ts (from apps/desktop), or pnpm --filter @gates-local/desktop build.

import { build, type BuildOptions } from "esbuild";
import { rmSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "out");
rmSync(out, { recursive: true, force: true });

const common: BuildOptions = {
  bundle: true,
  format: "cjs",
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
};

await Promise.all([
  build({
    ...common,
    entryPoints: [path.join(root, "src", "main.ts")],
    outfile: path.join(out, "main.cjs"),
    platform: "node",
    target: "node24",
  }),
  // A sandboxed preload cannot load Node built-ins: platform "browser" makes
  // any node: import a build error instead of a runtime one.
  build({
    ...common,
    entryPoints: [path.join(root, "src", "preload.ts")],
    outfile: path.join(out, "preload.cjs"),
    platform: "browser",
    target: "chrome140",
  }),
]);
