// The package scripts pack apps/web/dist as it is. Run alone (`pnpm --filter @gates-local/desktop
// package:linux`), nothing builds the page first, so a page older than its source would ship.
// This refuses when any source file the page is built from is newer than the built page.
// Run: node scripts/web-dist-check.ts (package.ts imports it first).
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..", "..", "..");
const built = path.join(repo, "apps/web/dist/index.html");
const sources = [
  path.join(repo, "apps/web/src"),
  path.join(repo, "apps/web/public"),
  path.join(repo, "apps/web/index.html"),
  path.join(repo, "apps/web/vite.config.ts"),
  path.join(repo, "packages/contracts/src"),
];

function newest(entry: string): { file: string; ms: number } | null {
  let s;
  try { s = statSync(entry); } catch { return null; }
  if (!s.isDirectory()) return { file: entry, ms: s.mtimeMs };
  let best: { file: string; ms: number } | null = null;
  for (const name of readdirSync(entry)) {
    const n = newest(path.join(entry, name));
    if (n !== null && (best === null || n.ms > best.ms)) best = n;
  }
  return best;
}

let builtMs: number;
try { builtMs = statSync(built).mtimeMs; } catch {
  console.error("apps/web/dist is missing. Run the root `pnpm package:linux` or `pnpm package:win`, which build the page first.");
  process.exit(1);
}
const latest = sources.map(newest).filter((n) => n !== null).toSorted((a, b) => b.ms - a.ms)[0];
if (latest !== undefined && latest.ms > builtMs) {
  const minutes = Math.round((latest.ms - builtMs) / 60_000);
  console.error(`apps/web/dist is older than its source (${path.relative(repo, latest.file)} is ${minutes} min newer). Run the root \`pnpm package:linux\` or \`pnpm package:win\`, which build the page first.`);
  process.exit(1);
}
