// Split the blocking browser project into duration-balanced shards that run at once.
// Every shard is its own Playwright run with its own stack: a private loopback (a user and
// network namespace, so the fixed ports 5286..5289 never meet), its own home, data and
// results folders, and its own JSON report. The caller sums the reports and checks that
// the shards together ran every listed test exactly once.
//
//   node scripts/e2e-shards.ts --write-durations <out.json> <playwright json report>...
//     writes the seconds-per-spec-file table a later run takes as GL_E2E_DURATIONS
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";

export interface SpecFile { file: string; tests: number }
export interface Listing { files: SpecFile[]; total: number }

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Tests per spec file from `playwright test --list --reporter=json` (files relative to the test dir). */
export function parseListing(raw: unknown): Listing {
  if (!record(raw) || !Array.isArray(raw["suites"]) || !record(raw["stats"])) throw new Error("Playwright list output is not a JSON report");
  const counts = new Map<string, number>();
  const visit = (suite: unknown, file: string) => {
    if (!record(suite)) return;
    for (const spec of Array.isArray(suite["specs"]) ? suite["specs"] : []) {
      if (record(spec) && Array.isArray(spec["tests"])) counts.set(file, (counts.get(file) ?? 0) + spec["tests"].length);
    }
    for (const child of Array.isArray(suite["suites"]) ? suite["suites"] : []) visit(child, file);
  };
  for (const suite of raw["suites"]) if (record(suite) && typeof suite["file"] === "string") visit(suite, suite["file"]);
  const files = [...counts].map(([file, tests]) => ({ file, tests })).toSorted((a, b) => a.file.localeCompare(b.file));
  return { files, total: files.reduce((n, f) => n + f.tests, 0) };
}

export function listSpecs(playwright: string[], cwd: string, env: NodeJS.ProcessEnv, args: string[]): Listing {
  const [file, ...rest] = playwright;
  if (!file) throw new Error("Empty Playwright command");
  const { PLAYWRIGHT_JSON_OUTPUT_FILE: _ignored, ...listEnv } = env;
  const out = execFileSync(file, [...rest, "test", ...args, "--list", "--reporter=json"], { cwd, env: listEnv, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  return parseListing(JSON.parse(out));
}

/**
 * Longest-first into the lightest shard. A file's weight is its measured seconds, or for a file
 * the table has not seen, its test count times the measured seconds per test. The desktop specs
 * go in as one unit: every shard shares the one display, and so its clipboard and focus.
 */
export function planShards(files: readonly SpecFile[], shards: number, seconds: Readonly<Record<string, number>> = {}): string[][] {
  const known = files.filter((f) => typeof seconds[f.file] === "number");
  const perTest = known.length ? known.reduce((s, f) => s + (seconds[f.file] ?? 0), 0) / Math.max(1, known.reduce((n, f) => n + f.tests, 0)) : 1;
  const weight = (f: SpecFile) => seconds[f.file] ?? f.tests * perTest;
  const desktop = files.filter((f) => f.file.endsWith("-desktop.spec.ts"));
  const units = [...files.filter((f) => !desktop.includes(f)).map((f) => [f]), ...(desktop.length ? [desktop] : [])];
  const unitWeight = (u: readonly SpecFile[]) => u.reduce((s, f) => s + weight(f), 0);
  const count = Math.max(1, Math.min(shards, units.length));
  const plan = Array.from({ length: count }, () => ({ load: 0, files: [] as string[] }));
  for (const u of units.toSorted((a, b) => unitWeight(b) - unitWeight(a) || a[0]!.file.localeCompare(b[0]!.file))) {
    const lightest = plan.reduce((min, s) => (s.load < min.load ? s : min));
    lightest.load += unitWeight(u);
    lightest.files.push(...u.map((f) => f.file));
  }
  return plan.map((s) => s.files.toSorted());
}

/** A Playwright file filter that matches exactly this spec file below the test dir. */
export function fileFilter(testDir: string, file: string): string {
  const full = path.resolve(testDir, file).split(path.sep).join("/");
  return `/${full.replaceAll(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$/`;
}

/** Half the cores, one stack and one browser per shard; at most eight. */
export function defaultShards(cores = availableParallelism()): number {
  return Math.max(1, Math.min(8, Math.floor(cores / 2)));
}

/** The command prefix that gives a shard a private loopback, or undefined where that is unavailable. */
export const ISOLATE = ["unshare", "--user", "--map-current-user", "--keep-caps", "--net", "--fork", "sh", "-c", 'ip link set lo up && exec "$@"', "shard"];

export function canIsolate(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "linux") return false;
  try {
    execFileSync(ISOLATE[0]!, [...ISOLATE.slice(1), "true"], { env, stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Shard i's own home, data and results; the browser cache stays the caller's. */
export function shardEnv(base: NodeJS.ProcessEnv, root: string, index: number, reportFile: string): NodeJS.ProcessEnv {
  const home = path.join(root, `s${index}`);
  for (const dir of ["h", "t", "data", "results"]) mkdirSync(path.join(home, dir), { recursive: true });
  const h = path.join(home, "h");
  // The stack's phone socket folder sits here and the server makes only its last part; a
  // commit's stack from before it made the parent itself still runs in a fresh home.
  mkdirSync(path.join(h, ".cache", "gates-local-e2e"), { recursive: true });
  return {
    ...base,
    HOME: h, USERPROFILE: h, TMPDIR: path.join(home, "t"), TEMP: path.join(home, "t"), TMP: path.join(home, "t"),
    XDG_CACHE_HOME: path.join(h, ".cache"), XDG_CONFIG_HOME: path.join(h, ".config"), XDG_DATA_HOME: path.join(h, ".local", "share"),
    // A home of its own would hide Playwright's default browser cache: pin the caller's.
    PLAYWRIGHT_BROWSERS_PATH: base["PLAYWRIGHT_BROWSERS_PATH"] ?? path.join(base["HOME"] ?? "", ".cache", "ms-playwright"),
    PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile,
    GL_E2E_DATA_ROOT: path.join(home, "data"),
    GL_E2E_RESULTS: path.join(home, "results"),
    // The build step already built the client; shards serve it and never rebuild it at once.
    GL_E2E_PREBUILT: "1",
  };
}

/** A balance hint only: a missing or unreadable table is an empty one. */
export function readDurations(file: string): Record<string, number> {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { return {}; }
  if (!record(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === "number" && e[1] >= 0));
}

/** Seconds per spec file from finished Playwright JSON reports (the mean where a file ran in several). */
export function durationsFrom(reports: unknown[]): Record<string, number> {
  const sums = new Map<string, { s: number; n: number }>();
  for (const raw of reports) {
    const per = new Map<string, number>();
    const visit = (suite: unknown, file: string) => {
      if (!record(suite)) return;
      for (const spec of Array.isArray(suite["specs"]) ? suite["specs"] : []) {
        if (!record(spec) || !Array.isArray(spec["tests"])) continue;
        for (const t of spec["tests"]) {
          if (!record(t) || !Array.isArray(t["results"])) continue;
          for (const r of t["results"]) if (record(r) && typeof r["duration"] === "number") per.set(file, (per.get(file) ?? 0) + r["duration"] / 1000);
        }
      }
      for (const child of Array.isArray(suite["suites"]) ? suite["suites"] : []) visit(child, file);
    };
    if (record(raw) && Array.isArray(raw["suites"])) for (const suite of raw["suites"]) if (record(suite) && typeof suite["file"] === "string") visit(suite, suite["file"]);
    for (const [file, s] of per) { const e = sums.get(file) ?? { s: 0, n: 0 }; e.s += s; e.n += 1; sums.set(file, e); }
  }
  return Object.fromEntries([...sums].toSorted(([a], [b]) => a.localeCompare(b)).map(([file, { s, n }]) => [file, Math.round((s / n) * 10) / 10]));
}

if (import.meta.main) {
  const [flag, out, ...reports] = process.argv.slice(2);
  if (flag !== "--write-durations" || !out || reports.length === 0) {
    console.error("Usage: node scripts/e2e-shards.ts --write-durations <out.json> <playwright json report>...");
    process.exit(2);
  }
  const table = durationsFrom(reports.map((r) => JSON.parse(readFileSync(r, "utf8")) as unknown));
  writeFileSync(out, JSON.stringify(table, null, 1) + "\n");
  console.log(`${out}: ${Object.keys(table).length} spec files`);
}
