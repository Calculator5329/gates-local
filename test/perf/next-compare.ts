// Alternates two prepared builds through the journeys that record cost, and
// scores them with the shuffle test in score-next.ts. Timing is informational
// and sets no exit code.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { ROOT } from "../e2e/env.ts";
import { prepareFixture } from "./fixture.ts";
import { limitEnv, limited, parseLimit, readLimit, type LimitReading } from "./limits.ts";
import { ownProcesses } from "./processes.ts";
import { parseRun, scoreNext, scoredMarkdown, type Verdict } from "./score-next.ts";
import { NEXT_DEFAULT, nextJourneys } from "./next-journeys.ts";
import type { Run } from "./stats.ts";

const { values } = parseArgs({ options: {
  prepared: { type: "string" }, out: { type: "string", default: "perf-results-next" }, only: { type: "string", default: NEXT_DEFAULT },
  rounds: { type: "string", default: "4" }, samples: { type: "string", default: "2" }, self: { type: "boolean" },
  throttle: { type: "string", default: "1" }, paste: { type: "boolean" }, "budget-seconds": { type: "string", default: "780" },
  limit: { type: "string" }, "limit-base": { type: "string" }, "limit-candidate": { type: "string" },
} });
const selected = nextJourneys(values.only);
if (!values.prepared) throw new Error("Use --prepared DIR from perf:compare --prepare");
const rounds = Number(values.rounds), samples = Number(values.samples), budget = Number(values["budget-seconds"]);
const source = path.resolve(values.prepared), out = path.resolve(values.out);
mkdirSync(out, { recursive: true });
const manifest: unknown = JSON.parse(readFileSync(path.join(source, "commits.json"), "utf8"));
if (typeof manifest !== "object" || manifest === null || !("base" in manifest) || !("candidate" in manifest)
  || typeof manifest.base !== "string" || typeof manifest.candidate !== "string") throw new Error("Invalid commit manifest");
const commits = { base: manifest.base, candidate: values.self ? manifest.base : manifest.candidate };
// Each arm can run in a smaller machine (limits.ts). --limit covers both arms;
// --self with --limit-candidate shows what the limit alone costs one build.
const limitOf = (spec: string | undefined) => spec === undefined ? undefined : parseLimit(spec);
const limits = { base: limitOf(values["limit-base"] ?? values.limit), candidate: limitOf(values["limit-candidate"] ?? values.limit) };
const started = Date.now();
const elapsed = () => (Date.now() - started) / 1000;

const shutdown = new AbortController();
process.on("SIGTERM", () => { shutdown.abort(); process.exitCode = 143; });
process.on("SIGINT", () => { shutdown.abort(); process.exitCode = 130; });
const processes = ownProcesses(shutdown.signal);
async function command(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const child = processes.spawn(args[0]!, args.slice(1), { cwd, env, stdio: "inherit" });
  try {
    const code = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 128 : 1))); });
    shutdown.signal.throwIfAborted();
    if (code !== 0) throw new Error(`${args[0]} exited ${code}; no timing verdict produced`);
  } finally { await processes.stop(child); }
}

const cache = path.join(homedir(), ".cache", "gates-local-perf");
mkdirSync(cache, { recursive: true });
const scratch = mkdtempSync(path.join(cache, "next-"));
type Arm = "base" | "candidate";
const arms: Arm[] = ["base", "candidate"];
const subjects = { base: path.join(scratch, "base"), candidate: path.join(scratch, "candidate") };
for (const arm of arms) {
  mkdirSync(subjects[arm]);
  execFileSync("tar", ["-xf", path.join(source, values.self ? "base.tar" : `${arm}.tar`), "-C", subjects[arm]]);
  await command(["pnpm", "install", "--frozen-lockfile"], subjects[arm]);
  await command(["pnpm", "--filter", "@gates-local/web", "build"], subjects[arm]);
}
const fixtures = { base: await prepareFixture(subjects.base), candidate: await prepareFixture(subjects.candidate) };
console.log(`NEXT setup finished at ${elapsed().toFixed(0)}s`);

const runs: Record<Arm, Run[]> = { base: [], candidate: [] }, counters: Record<Arm, Run[]> = { base: [], candidate: [] };
const boxes: Record<Arm, LimitReading[]> = { base: [], candidate: [] };
const journeys = ["pnpm", "exec", "playwright", "test", "-c", "test/perf/next.config.ts"];
let longestRound = 0;
for (let round = 0; round < rounds; round++) {
  if (round > 0 && elapsed() + longestRound > budget) { console.log(`NEXT stopping after ${round} rounds: the next would pass the ${budget}s budget`); break; }
  const roundStart = elapsed();
  const order: Arm[] = round % 2 === 0 ? ["base", "candidate"] : ["candidate", "base"];
  for (const arm of order) {
    console.log(`NEXT round ${round + 1}/${rounds} ${arm} at ${elapsed().toFixed(0)}s`);
    const runOut = path.join(out, `round-${round + 1}-${arm}`);
    const limit = limits[arm], report = path.join(out, `round-${round + 1}-${arm}.limit`);
    try { await command(limit ? limited(limit, journeys, report) : journeys, ROOT, {
      ...(limit ? limitEnv(process.env) : process.env), GL_PERF_LIMIT: limit?.spec ?? "", GL_PERF_TARGET: subjects[arm], GL_PERF_FIXTURE: fixtures[arm], GL_PERF_COMMIT: commits[arm], GL_PERF_ARM: arm,
      GL_PERF_ROUND: String(round + 1), GL_PERF_SAMPLES: String(samples), GL_PERF_OUT: runOut, GL_PERF_ONLY: selected.join(","),
      GL_PERF_THROTTLE: values.throttle, GL_PERF_PASTE: values.paste ? "1" : "0",
    }); } finally {
      // Read even when the run failed: a run killed for memory says so here.
      if (limit && existsSync(report)) {
        const reading = readLimit(report);
        boxes[arm].push(reading);
        console.log(`NEXT round ${round + 1} ${arm} in ${limit.spec}: peak memory ${reading.peakMb} MB, ${reading.oomKills} killed for memory, ${reading.cpuSeconds} s of processor time, held back ${reading.heldBackSeconds} s`);
      }
    }
    // A slowed run that was never held back was not slowed, so it is not recorded as one.
    if (limit?.speed && boxes[arm].at(-1)?.heldBackSeconds === 0) throw new Error(`${limit.spec} never held this run back; this machine's scheduler may not enforce a speed limit`);
    runs[arm].push(parseRun(readFileSync(path.join(runOut, "run.json"), "utf8")));
    counters[arm].push(parseRun(readFileSync(path.join(runOut, "counters.json"), "utf8")));
  }
  longestRound = Math.max(longestRound, elapsed() - roundStart);
}
shutdown.signal.throwIfAborted();
await processes.close();

const verdicts: Verdict[] = [...scoreNext(runs.base, runs.candidate), ...scoreNext(counters.base, counters.candidate)];
writeFileSync(path.join(out, "scored.json"), JSON.stringify({ schema: 1, informational: true, commits, limits: { base: limits.base?.spec ?? null, candidate: limits.candidate?.spec ?? null }, boxes, rounds: runs.base.length, samples, throttle: Number(values.throttle), seconds: elapsed(), verdicts }, null, 2) + "\n", { flag: "wx" });
const markdown = scoredMarkdown(verdicts);
writeFileSync(path.join(out, "scored.md"), markdown, { flag: "wx" });
console.log(markdown);
console.log(`NEXT finished in ${elapsed().toFixed(0)}s with ${runs.base.length} rounds`);
