/**
 * pnpm release:gate: what has to pass before a release goes out (owner ruling 2026-11-20).
 * Types, lint, the build, and the everyday journeys in test/e2e/journeys.txt, in the checkout
 * it is started in. It writes one report in release:check's shape with "part": "gate", which
 * pnpm release:tag accepts. The whole release:check (unit tests, every browser test) runs after
 * the release and never holds it.
 *
 *   pnpm release:gate [--list FILE] [--report FILE]
 *   pnpm release:gate --part checks|journeys [--shard I/N] --commit SHA --remote URL --report FILE
 *       one piece, for parallel pool jobs on exported source (no .git: commit and remote are given)
 *   pnpm release:gate ... [FILE.spec.ts...]   spec files narrow the run like Playwright's own file filters
 *   pnpm release:gate --merge --report FILE PIECE.json...
 *       the pieces as one gate report; a missing, repeated or red piece makes it red
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { GATE_STEPS, parseReport, playwrightCommand, readBlockingPlaywright, runReleaseCommand, type Failure, type ReleaseReport, type Step } from "./release.ts";

export type GatePart = "gate" | "checks" | "journeys";
export interface Shard { current: number; total: number }
/** What the journey list held when it ran, so the merge can tell every shard ran the same list. */
export interface JourneyRecord { list: string; sha256: string; lines: number; tests: number; shard?: Shard }
export type GateReport = ReleaseReport & { part: GatePart; journeys?: JourneyRecord };

export const DEFAULT_LIST = "test/e2e/journeys.txt";
const CONFIG = ["-c", "test/e2e/playwright.config.ts", "--project=e2e"];
const PART_STEPS: Record<GatePart, readonly string[]> = { gate: GATE_STEPS, checks: ["typecheck", "lint", "build"], journeys: ["build", "journeys-list", "e2e"] };
/** Lane packet's reporter writes a bug packet per red test; the gate's --reporter keeps it when it exists. */
const PACKET_REPORTER = "test/e2e/packet/reporter.ts";

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** One line of a Playwright --test-list file. */
export interface ListLine { line: string; project?: string; file: string; titlePath: string[] }

/** Parse a --test-list file the way Playwright 1.61 does: `[project] › file:line:col › title › title`, # comments. */
export function parseTestList(text: string): ListLine[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).map((line) => {
    const tokens = line.split(line.includes("›") ? "›" : ">").map((token) => token.trim());
    let project: string | undefined;
    if (tokens[0]?.startsWith("[")) {
      if (!tokens[0].endsWith("]")) throw new Error(`Malformed journey line: ${line}`);
      project = tokens[0].slice(1, -1);
      tokens.shift();
    }
    const location = tokens[0];
    if (!location) throw new Error(`Journey line names no file: ${line}`);
    // Playwright drops a trailing :line or :line:col from the file.
    return { line, ...(project === undefined ? {} : { project }), file: location.replace(/(:\d+){1,2}$/, ""), titlePath: tokens.slice(1) };
  });
}

/** A test Playwright listed: its project, file (relative to the test folder) and describe-plus-test titles. */
export interface ListedCase { project: string; file: string; titles: string[] }

/** The tests in a `playwright test --list --reporter=json` report. */
export function listedCases(json: unknown): ListedCase[] {
  if (!record(json) || !Array.isArray(json["suites"])) throw new Error("Playwright's test list has no suites");
  const cases: ListedCase[] = [];
  const visit = (suite: unknown, titles: string[], file: string) => {
    if (!record(suite)) return;
    if (Array.isArray(suite["specs"])) for (const spec of suite["specs"]) {
      if (!record(spec) || typeof spec["title"] !== "string" || !Array.isArray(spec["tests"])) continue;
      const specFile = typeof spec["file"] === "string" ? spec["file"] : file;
      for (const test of spec["tests"]) if (record(test) && typeof test["projectName"] === "string") cases.push({ project: test["projectName"], file: specFile, titles: [...titles, spec["title"]] });
    }
    if (Array.isArray(suite["suites"])) for (const child of suite["suites"]) if (record(child)) visit(child, typeof child["title"] === "string" ? [...titles, child["title"]] : titles, file);
  };
  // A file's own suite is titled with its path; describe blocks nest inside it.
  for (const suite of json["suites"]) if (record(suite)) visit(suite, [], typeof suite["file"] === "string" ? suite["file"] : "");
  return cases;
}

/** The list lines no listed test matches. Playwright skips them in silence; the gate refuses them. */
export function unmatchedLines(lines: ListLine[], cases: ListedCase[]): ListLine[] {
  return lines.filter((want) => !cases.some((test) => (want.project === undefined || want.project === test.project) && want.file === test.file
    && want.titlePath.length <= test.titles.length && want.titlePath.every((title, i) => test.titles[i] === title)));
}

export function parseShard(text: string): Shard {
  const match = /^(\d+)\/(\d+)$/.exec(text);
  const current = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || current < 1 || total < 1 || current > total) throw new Error("--shard must be I/N with 1 <= I <= N");
  return { current, total };
}

export interface GateOptions {
  cwd: string;
  reportPath: string;
  list: string;
  part: GatePart;
  shard?: Shard;
  /** Required for exported source with no .git; in a git checkout they must agree with it. */
  commit?: string;
  remote?: string;
  signal?: AbortSignal;
  /** Spec files named on the command line, ANDed with the list (a pool shares slots only with named specs). */
  specs?: string[];
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A git checkout must be clean, so the report's commit is what ran; exported source takes the caller's word and says so. */
function whatRuns(options: GateOptions): { commit: string; remote: string; fromGit: boolean } {
  if (existsSync(path.join(options.cwd, ".git"))) {
    if (git(options.cwd, "status", "--porcelain")) throw new Error("The checkout has changed or untracked files: commit them or move them out, so the report's commit is what ran");
    const head = git(options.cwd, "rev-parse", "HEAD");
    if (options.commit !== undefined && options.commit !== head) throw new Error(`--commit ${options.commit} is not this checkout's HEAD ${head}`);
    return { commit: head, remote: options.remote ?? git(options.cwd, "remote", "get-url", "origin"), fromGit: true };
  }
  if (!options.commit || !options.remote) throw new Error("Source without .git needs --commit and --remote");
  return { commit: options.commit, remote: options.remote, fromGit: false };
}

export async function runGate(options: GateOptions): Promise<GateReport> {
  const began = Date.now();
  const reportPath = path.resolve(options.reportPath);
  if (existsSync(reportPath)) throw new Error("Report already exists: choose a new --report path to keep earlier evidence");
  if (options.shard && options.part !== "journeys") throw new Error("--shard runs one piece of the journeys: use it with --part journeys");
  mkdirSync(path.dirname(reportPath), { recursive: true });
  const artifacts = `${reportPath}.artifacts`;
  mkdirSync(artifacts);
  const report: GateReport = {
    schemaVersion: 1, commit: "", remote: "", startedAt: new Date(began).toISOString(), finishedAt: "", durationMs: 0, status: "failed",
    tools: { node: process.version }, steps: [], tests: { unit: { passed: 0, failed: 0, skipped: 0 }, e2e: { passed: 0, failed: 0, skipped: 0 } },
    failures: [], limits: [], part: options.part,
  };
  const wanted = PART_STEPS[options.part];
  const fail = (step: string, test: string, message: string) => report.failures.push({ step, test, message });
  try {
    const source = whatRuns(options);
    report.commit = source.commit;
    report.remote = source.remote;
    if (!source.fromGit) report.limits?.push("Exported source without .git: the caller gave the commit and remote.");
    const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", NO_COLOR: "1" };
    const version = (argv: string[]) => {
      const run = spawnSync(argv[0] ?? "", argv.slice(1), { cwd: options.cwd, env, encoding: "utf8" });
      return run.status === 0 ? run.stdout.trim() : "unavailable";
    };
    const playwright = playwrightCommand(options.cwd);
    report.tools["git"] = version(["git", "--version"]);
    report.tools["pnpm"] = version(["pnpm", "--version"]);
    report.tools["playwright"] = version([...playwright, "--version"]);

    const step = async (name: string, argv: string[], runEnv = env) => {
      const saved: Step = { name, blocking: true, status: "failed", exitCode: -1, durationMs: 0 };
      report.steps.push(saved);
      const start = Date.now();
      const r = await runReleaseCommand(argv, options.cwd, runEnv, path.join(artifacts, `${name}.log`), options.signal);
      Object.assign(saved, { status: r.code === 0 ? "passed" : "failed", exitCode: r.code, durationMs: Date.now() - start });
      if (r.interrupted || options.signal?.aborted) throw new Error(`Gate interrupted during ${name}`);
      if (r.code) fail(name, "command", r.output.slice(-8_000));
      return r.code === 0;
    };
    if (wanted.includes("typecheck")) await step("typecheck", ["pnpm", "typecheck"]);
    if (wanted.includes("lint")) await step("lint", ["pnpm", "lint"]);
    const built = await step("build", ["pnpm", "build"]);
    if (wanted.includes("e2e")) {
      const listed = checkList(options, playwright, env, artifacts, report);
      if (!built || !listed) fail("e2e", "command", built ? "The journey list did not check out; the journeys did not run." : "The build failed; the journeys did not run.");
      else {
        const json = path.join(artifacts, "e2e.json");
        const packet = path.join(options.cwd, PACKET_REPORTER);
        const reporters = ["list", "json", ...(existsSync(packet) ? [packet] : [])].join(",");
        const ran = await step("e2e", [...playwright, "test", ...CONFIG, "--test-list", path.resolve(options.list), "--forbid-only", `--reporter=${reporters}`, ...(options.specs ?? []),
          ...(options.shard ? [`--shard=${options.shard.current}/${options.shard.total}`] : [])],
        { ...env, GL_E2E_PREBUILT: "1", PLAYWRIGHT_JSON_OUTPUT_FILE: json });
        try { report.tests.e2e = readBlockingPlaywright(json, report); }
        catch (error) { fail("e2e", "report", errorText(error)); }
        const count = report.tests.e2e.passed + report.tests.e2e.failed + report.tests.e2e.skipped;
        if (ran && count === 0) fail("e2e", "coverage", "No journey ran.");
        // Contract with lane journeys: one test per list line, so the run must equal the line count.
        if (!options.shard && report.journeys && count !== report.journeys.lines) fail("e2e", "coverage", `Ran ${count} journeys; the list has ${report.journeys.lines} lines.`);
      }
    }
    // Packaging or a test that rewrote tracked files would make the report's commit untrue.
    if (source.fromGit && (git(options.cwd, "status", "--porcelain") || git(options.cwd, "rev-parse", "HEAD") !== source.commit)) fail("source", "command", "The checkout changed while the gate ran.");
    const passed = wanted.every((name) => report.steps.some((s) => s.name === name && s.status === "passed"));
    if (passed && report.failures.length === 0 && report.tests.e2e.failed === 0 && report.tests.e2e.skipped === 0) report.status = "passed";
  } catch (error) {
    if (options.signal?.aborted) report.interrupted = true;
    fail(report.steps.at(-1)?.name ?? "setup", "command", errorText(error));
  } finally {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - began;
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  }
  return report;
}

/** The journeys-list step: every line in the list must still name a test. */
function checkList(options: GateOptions, playwright: string[], env: NodeJS.ProcessEnv, artifacts: string, report: GateReport): boolean {
  const saved: Step = { name: "journeys-list", blocking: true, status: "failed", exitCode: 1, durationMs: 0 };
  report.steps.push(saved);
  const start = Date.now();
  const list = path.resolve(options.list);
  try {
    const text = readFileSync(list, "utf8");
    const lines = parseTestList(text);
    if (lines.length === 0) throw new Error(`${options.list} lists no journeys`);
    const run = spawnSync(playwright[0] ?? "", [...playwright.slice(1), "test", ...CONFIG, "--test-list", list, "--list", "--reporter=json"], { cwd: options.cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(path.join(artifacts, "journeys-list.json"), run.stdout);
    if (run.status !== 0) throw new Error(`playwright --list exited ${run.status ?? run.signal}: ${run.stderr.slice(-4_000)}`);
    const cases = listedCases(JSON.parse(run.stdout));
    const missing = unmatchedLines(lines, cases);
    for (const line of missing) report.failures.push({ step: "journeys-list", test: line.line, message: "No test matches this journey line: it was renamed, moved or deleted. Fix the list; the gate never shrinks in silence." });
    report.journeys = { list: options.list, sha256: createHash("sha256").update(text).digest("hex"), lines: lines.length, tests: cases.length, ...(options.shard ? { shard: options.shard } : {}) };
    if (missing.length === 0) Object.assign(saved, { status: "passed", exitCode: 0 });
  } catch (error) {
    report.failures.push({ step: "journeys-list", test: options.list, message: errorText(error) });
  }
  saved.durationMs = Date.now() - start;
  return saved.status === "passed";
}

function isGateReport(v: unknown): v is GateReport {
  return record(v) && (v["part"] === "gate" || v["part"] === "checks" || v["part"] === "journeys");
}

/**
 * The parallel pieces as one gate report: one checks piece and journeys shards 1..N, each once,
 * for one commit and one list. Anything missing, repeated or red makes the merged report red.
 */
export function mergeGate(inputs: unknown[]): GateReport {
  const pieces = inputs.map((input) => {
    const report = parseReport(input);
    if (!isGateReport(report) || report.part === "gate") throw new Error("Only checks and journeys pieces merge into a gate");
    return report;
  });
  const first = pieces[0];
  if (!first) throw new Error("No gate pieces to merge");
  const failures: Failure[] = pieces.flatMap((p) => p.failures);
  const problem = (message: string) => failures.push({ step: "merge", test: "pieces", message });
  if (pieces.some((p) => p.commit !== first.commit || p.remote !== first.remote)) problem("The pieces name different commits or remotes.");
  const checks = pieces.filter((p) => p.part === "checks");
  const journeys = pieces.filter((p) => p.part === "journeys");
  if (checks.length !== 1) problem(`Expected one checks piece, got ${checks.length}.`);
  if (journeys.length === 0) problem("No journeys piece.");
  const total = journeys[0]?.journeys?.shard?.total ?? 1;
  const seen = journeys.map((p) => p.journeys?.shard?.current ?? 1).toSorted((a, b) => a - b);
  if (journeys.some((p) => (p.journeys?.shard?.total ?? 1) !== total) || seen.join() !== Array.from({ length: total }, (_, i) => i + 1).join()) problem(`Expected journeys shards 1 to ${total} once each, got ${seen.join(", ") || "none"}.`);
  const list = journeys[0]?.journeys;
  if (!list || journeys.some((p) => p.journeys?.sha256 !== list.sha256 || p.journeys.tests !== list.tests)) problem("The journeys pieces ran different lists, or one has no list record.");
  const e2e = { passed: 0, failed: 0, skipped: 0 };
  for (const p of journeys) { e2e.passed += p.tests.e2e.passed; e2e.failed += p.tests.e2e.failed; e2e.skipped += p.tests.e2e.skipped; }
  if (list && e2e.passed + e2e.failed + e2e.skipped !== list.lines) problem(`The shards ran ${e2e.passed + e2e.failed + e2e.skipped} journeys; the list has ${list.lines} lines.`);
  // One step per name: passed only when every piece that ran it passed; the slowest piece's time.
  const steps: Step[] = [];
  for (const name of GATE_STEPS) {
    const ran = pieces.flatMap((p) => p.steps.filter((s) => s.name === name));
    if (ran.length === 0) continue;
    const failed = ran.find((s) => s.status !== "passed");
    steps.push({ name, blocking: true, status: failed ? "failed" : "passed", exitCode: failed?.exitCode ?? 0, durationMs: Math.max(...ran.map((s) => s.durationMs)) });
  }
  const startedAt = pieces.map((p) => p.startedAt).toSorted()[0] ?? first.startedAt;
  const finishedAt = pieces.map((p) => p.finishedAt).toSorted().at(-1) ?? first.finishedAt;
  const passed = pieces.every((p) => p.status === "passed" && !p.interrupted) && failures.length === 0 && GATE_STEPS.every((name) => steps.some((s) => s.name === name && s.status === "passed"));
  return {
    schemaVersion: 1, commit: first.commit, remote: first.remote, startedAt, finishedAt, durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    status: passed ? "passed" : "failed", tools: Object.assign({}, ...journeys.map((p) => p.tools), ...checks.map((p) => p.tools)),
    steps, tests: { unit: { passed: 0, failed: 0, skipped: 0 }, e2e }, failures, limits: [...new Set(pieces.flatMap((p) => p.limits ?? []))], part: "gate",
    ...(list ? { journeys: { list: list.list, sha256: list.sha256, lines: list.lines, tests: list.tests } } : {}),
  };
}

if (import.meta.main) {
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      list: { type: "string" }, report: { type: "string" }, part: { type: "string" }, shard: { type: "string" },
      commit: { type: "string" }, remote: { type: "string" }, merge: { type: "boolean", default: false },
    } });
    const reportPath = path.resolve(values.report ?? path.join(homedir(), ".cache", "gates-local-release", `gate-${Date.now()}.json`));
    let report: GateReport;
    if (values.merge) {
      if (positionals.length === 0 || !values.report) throw new Error("Usage: pnpm release:gate --merge --report FILE PIECE.json...");
      if (existsSync(reportPath)) throw new Error("Report already exists: choose a new --report path to keep earlier evidence");
      report = mergeGate(positionals.map((file) => JSON.parse(readFileSync(file, "utf8")) as unknown));
      mkdirSync(path.dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    } else {
      const part = values.part ?? "gate";
      if (positionals.some((spec) => !spec.endsWith(".spec.ts")) || (positionals.length > 0 && part === "checks")) throw new Error("Positional arguments are spec files for the journeys, or report pieces with --merge");
      if (part !== "gate" && part !== "checks" && part !== "journeys") throw new Error("--part must be checks or journeys");
      report = await runGate({ cwd: process.cwd(), reportPath, list: values.list ?? DEFAULT_LIST, part, signal: abort.signal, specs: positionals,
        ...(values.shard ? { shard: parseShard(values.shard) } : {}), ...(values.commit ? { commit: values.commit } : {}), ...(values.remote ? { remote: values.remote } : {}) });
    }
    for (const f of report.failures) console.log(`RED ${f.step}: ${f.test}${f.message && f.test !== "command" ? "" : `\n${f.message.split("\n").slice(-12).join("\n")}`}`);
    const timing = report.steps.map((s) => `${s.name} ${(s.durationMs / 1000).toFixed(1)}s ${s.status}`).join(", ");
    console.log(`Release gate ${report.part} ${report.status}: ${reportPath} (${(report.durationMs / 1000).toFixed(1)}s; ${timing}; journeys ${report.tests.e2e.passed} passed, ${report.tests.e2e.failed} failed)`);
    process.exitCode = abort.signal.aborted ? 130 : report.status === "passed" ? 0 : 1;
  } catch (error) {
    console.error(`Release gate refused: ${errorText(error)}`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
