// Informational only: timing signals never set the process exit code.
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, freemem, homedir, loadavg, totalmem } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { ROOT } from "../e2e/env.ts";
import { compare, type Run } from "./stats.ts";
import { bundleSizeWarnings, bundleSize } from "../bundle-size.ts";
import { prepareFixture } from "./fixture.ts";
import { firstRunTimes } from "./first-run.ts";
import { ownProcesses } from "./processes.ts";
import { selectJourneys, THREAD_WINDOW_NOTE } from "./selection.ts";
import { desktopLaunchTimes } from "./desktop-launch.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  prepare: { type: "boolean" }, prepared: { type: "string" }, out: { type: "string", default: "perf-results" },
  rounds: { type: "string", default: "5" }, samples: { type: "string", default: "3" },
  self: { type: "boolean" }, analyze: { type: "string" },
  only: { type: "string" },
} });
const selected = selectJourneys(values.only);
const includeFirstRun = selected === undefined || selected.includes("first-run");
const includeDesktop = selected?.includes("desktop-launch") ?? false;
const browserJourneys = selected?.filter(name => name !== "desktop-launch");
const browserNeeded = browserJourneys === undefined || browserJourneys.length > 0;
const out = path.resolve(values.out);
const rounds = Number(values.rounds), samples = Number(values.samples);
if (!Number.isInteger(rounds) || rounds < 4 || !Number.isInteger(samples) || samples < 1) throw new Error("Use at least four rounds and one sample");
mkdirSync(out, { recursive: true });
function git(...args: string[]): string { return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim(); }
interface Inputs { base: string; candidate: string }
type Runs = { base: Run[]; candidate: Run[] };
type Bundles = { base: ReturnType<typeof bundleSize>; candidate: ReturnType<typeof bundleSize> };
function report(runs: Runs, commits: Inputs, count: number, repetitions: number, bundles: Bundles) {
  const changes = compare(runs.base, runs.candidate);
  const bundleWarnings = { base: bundleSizeWarnings(bundles.base), candidate: bundleSizeWarnings(bundles.candidate) };
  writeFileSync(path.join(out, "comparison.json"), JSON.stringify({ schema: 1, analysisVersion: 4, informational: true, commits, rounds: count, samples: repetitions, only: runs.base[0]?.only, bundles, bundleWarnings, threadWindowNote: THREAD_WINDOW_NOTE, changes }, null, 2) + "\n", { flag: "wx" });
  const lines = ["Timing is informational. Slower means a measured signal, never a release failure.", "", "| Action | Unit | Base median | Base p95 | Candidate median | Delta | Noise floor | Signal |", "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |", ...changes.map(c => `| ${c.action} | ${c.unit} | ${c.base.median.toFixed(2)} | ${c.base.p95.toFixed(2)} | ${c.candidate.median.toFixed(2)} | ${c.delta.toFixed(2)} | ${c.noiseFloor.toFixed(2)} | ${c.signal}${c.tooNoisy ? "; too noisy for small changes" : ""} |`)];
  lines.push("", THREAD_WINDOW_NOTE, "", "Bundle sizes are informational soft targets (KiB gzip).");
  for (const arm of ["base", "candidate"] as const) {
    lines.push(`${arm}: ${JSON.stringify(bundles[arm])}`, ...bundleWarnings[arm].map(warning => `${arm} warning: ${warning}`));
  }
  const markdown = lines.join("\n") + "\n";
  writeFileSync(path.join(out, "comparison.md"), markdown, { flag: "wx" });
  console.log(markdown);
  console.log(`Bundles (KiB gzip): ${JSON.stringify(bundles)}`);
}
if (values.analyze) {
  const folder = path.resolve(values.analyze);
  const prior = JSON.parse(readFileSync(path.join(folder, "comparison.json"), "utf8")) as { commits: Inputs; rounds: number; samples: number; bundles: Bundles };
  if (!Number.isInteger(prior.rounds) || prior.rounds < 4) throw new Error("Incomplete comparison metadata");
  const saved: Runs = { base: [], candidate: [] };
  for (const arm of ["base", "candidate"] as const) for (let round = 1; round <= prior.rounds; round++) {
    const run = JSON.parse(readFileSync(path.join(folder, `round-${round}-${arm}`, "run.json"), "utf8")) as Run;
    const firstRunFile = path.join(folder, `round-${round}-${arm}`, "first-run.json");
    if (existsSync(firstRunFile)) run.metrics.push(JSON.parse(readFileSync(firstRunFile, "utf8")) as Run["metrics"][number]);
    const desktopFile = path.join(folder, `round-${round}-${arm}`, "desktop-launch.json");
    if (existsSync(desktopFile)) run.metrics.push(...JSON.parse(readFileSync(desktopFile, "utf8")) as Run["metrics"]);
    if (run.commit !== prior.commits[arm] || run.round !== round || run.arm !== arm) throw new Error("Run identity differs from comparison metadata");
    saved[arm].push(run);
  }
  // New derived output, never overwrite measurements or the earlier analysis.
  report(saved, prior.commits, prior.rounds, prior.samples, prior.bundles);
  process.exit(0);
}
let inputs: Inputs;
let source: string;
if (values.prepared) {
  source = path.resolve(values.prepared);
  const manifest: unknown = JSON.parse(readFileSync(path.join(source, "commits.json"), "utf8"));
  if (typeof manifest !== "object" || manifest === null || !("base" in manifest) || !("candidate" in manifest)
    || typeof manifest.base !== "string" || typeof manifest.candidate !== "string"
    || ![manifest.base, manifest.candidate].every(s => /^[a-f0-9]{40}$/.test(s))) throw new Error("Invalid commit manifest");
  inputs = { base: manifest.base, candidate: manifest.candidate };
} else {
  if (positionals.length !== 2) throw new Error("Usage: node test/perf/compare.ts [--prepare] BASE CANDIDATE [--out DIR], or --prepared DIR");
  inputs = { base: git("rev-parse", "--verify", `${positionals[0]}^{commit}`), candidate: git("rev-parse", "--verify", `${positionals[1]}^{commit}`) };
  source = out;
  for (const arm of ["base", "candidate"] as const) {
    const archive = openSync(path.join(source, `${arm}.tar`), "wx");
    try { execFileSync("git", ["archive", "--format=tar", inputs[arm]], { cwd: ROOT, stdio: ["ignore", archive, "pipe"] }); }
    finally { closeSync(archive); }
  }
  writeFileSync(path.join(out, "commits.json"), JSON.stringify(inputs, null, 2) + "\n", { flag: "wx" });
}
if (values.prepare) {
  console.log(`Prepared ${inputs.base} and ${inputs.candidate}. Submit this tree with its input archives to the browser runner.`);
  process.exit(0);
}
if (values.self) inputs = { base: inputs.base, candidate: inputs.base };
const cache = path.join(homedir(), ".cache", "gates-local-perf");
mkdirSync(cache, { recursive: true });
const scratch = mkdtempSync(path.join(cache, "compare-"));
const subjects = { base: path.join(scratch, "base"), candidate: path.join(scratch, "candidate") };
const shutdown = new AbortController();
const processes = ownProcesses(shutdown.signal);
async function command(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const child = processes.spawn(args[0]!, args.slice(1), { cwd, env, stdio: "inherit" });
  try {
    const code = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 128 : 1))); });
    shutdown.signal.throwIfAborted();
    if (code !== 0) throw new Error(`${args[0]} exited ${code}; no timing verdict produced`);
  } finally { await processes.stop(child); }
}
process.on("SIGTERM", () => { shutdown.abort(); process.exitCode = 143; });
process.on("SIGINT", () => { shutdown.abort(); process.exitCode = 130; });
for (const arm of ["base", "candidate"] as const) {
  mkdirSync(subjects[arm]);
  execFileSync("tar", ["-xf", path.join(source, values.self ? "base.tar" : `${arm}.tar`), "-C", subjects[arm]]);
  await command(["pnpm", "install", "--frozen-lockfile"], subjects[arm]);
  await command(["pnpm", "--filter", "@gates-local/web", "build"], subjects[arm]);
  if (includeDesktop) await command(["pnpm", "--filter", "@gates-local/desktop", "build"], subjects[arm]);
}
const fixtures = {
  base: await prepareFixture(subjects.base),
  candidate: await prepareFixture(subjects.candidate),
};
const runs: Runs = { base: [], candidate: [] };
for (let round = 0; round < rounds; round++) {
  // AB BA AB BA: swap which build goes first to reduce warm-up and drift bias.
  for (const arm of (round % 2 === 0 ? ["base", "candidate"] : ["candidate", "base"]) as ("base" | "candidate")[]) {
    console.log(`PERF round ${round + 1}/${rounds} ${arm} ${inputs[arm]}`);
    const runOut = path.join(out, `round-${round + 1}-${arm}`);
    mkdirSync(runOut, { recursive: true });
    if (browserNeeded) {
    await command(["pnpm", "exec", "playwright", "test", "-c", "test/perf/playwright.config.ts"], ROOT, {
      ...process.env, GL_PERF_TARGET: subjects[arm], GL_PERF_FIXTURE: fixtures[arm], GL_PERF_COMMIT: inputs[arm], GL_PERF_ARM: arm,
      GL_PERF_ROUND: String(round + 1), GL_PERF_SAMPLES: String(samples), GL_PERF_OUT: runOut,
      GL_PERF_ONLY: selected?.join(",") ?? "",
    });
    } else {
      const run: Run = { schema: 1, commit: inputs[arm], round: round + 1, arm, only: selected,
        browser: "Electron (built desktop)", machine: { cpus: availableParallelism(), memoryBytes: totalmem(), freeBytes: freemem(), loadBefore: loadavg(), loadAfter: loadavg() },
        fake: { firstTokenDelayMs: 40, tokenDelayMs: 8, burstTokens: 8, thinking: false, loadDelayMs: 0, longMarkdown: { tokenDelayMs: 8, burstTokens: 8 } }, metrics: [] };
      writeFileSync(path.join(runOut, "run.json"), JSON.stringify(run, null, 2) + "\n", { flag: "wx" });
    }
    const run = JSON.parse(readFileSync(path.join(runOut, "run.json"), "utf8")) as Run;
    run.only = selected;
    if (run.commit !== inputs[arm] || (run.metrics.length === 0 && browserNeeded && !includeFirstRun)) throw new Error("Incomplete run record");
    if (includeFirstRun) {
      const firstRun = await firstRunTimes(subjects[arm], fixtures[arm], samples, round === 0 && arm === "candidate" ? path.join(runOut, "first-run.png") : undefined, shutdown.signal);
      writeFileSync(path.join(runOut, "first-run.json"), JSON.stringify(firstRun, null, 2) + "\n", { flag: "wx" });
      run.metrics.push(firstRun);
    }
    if (includeDesktop) {
      const desktop = await desktopLaunchTimes(subjects[arm], fixtures[arm], samples, runOut, shutdown.signal);
      writeFileSync(path.join(runOut, "desktop-launch.json"), JSON.stringify(desktop, null, 2) + "\n", { flag: "wx" });
      run.metrics.push(...desktop);
    }
    runs[arm].push(run);
  }
}
shutdown.signal.throwIfAborted();
await processes.close();
const bundles = { base: bundleSize(path.join(subjects.base, "apps/web/dist")), candidate: bundleSize(path.join(subjects.candidate, "apps/web/dist")) };
report(runs, inputs, rounds, samples, bundles);
