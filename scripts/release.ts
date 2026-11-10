import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { compare, newestRelease, parseRelease } from "../apps/server/src/update/semver.ts";
import { groupAlive, processAlive } from "../apps/server/src/process-state.ts";

export interface Totals { passed: number; failed: number; skipped: number }
export interface Step { name: string; blocking: boolean; status: "passed" | "failed"; exitCode: number; durationMs: number }
export interface Failure { step: string; test: string; message: string }
export interface PerformanceComparison {
  status: "available" | "unavailable";
  candidate: string;
  base?: string;
  baseSource?: "release" | "fallback";
  releaseTag?: string;
  note?: string;
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  artifacts: string;
  reportPath: string;
  logPath: string;
  rounds: number;
  samples: number;
}
export interface ReleaseReport {
  schemaVersion: 1;
  commit: string;
  remote: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: "passed" | "failed";
  tools: Record<string, string>;
  steps: Step[];
  tests: { unit: Totals; e2e: Totals };
  failures: Failure[];
  // Eligibility deliberately never reads or validates informational payloads.
  timing?: unknown;
  performance?: unknown;
  interrupted?: boolean;
  scratchRemoved?: boolean;
  limits?: string[];
}
export interface CheckOptions { cwd: string; remote?: string; commit?: string; reportPath: string; storeDir?: string; browserPath?: string; signal?: AbortSignal; timingTimeoutMs?: number; performanceBase?: string; performanceTimeoutMs?: number }

// The first corrected comparison scorer is the stated base before the first release.
const FIRST_PERFORMANCE_BASE = "a369f0a3b7280f33802d6f816287546814da99eb";

const BLOCKING = ["clone", "checkout", "install", "verify", "build", "desktop-build", "e2e"];
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const emptyTotals = (): Totals => ({ passed: 0, failed: 0, skipped: 0 });
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const remoteTags = (cwd: string) => git(cwd, "ls-remote", "--tags", "origin").split("\n").map((line) => line.split("\t")[1]?.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "") ?? "");
const fetchMain = (cwd: string) => {
  git(cwd, "fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main");
  return git(cwd, "rev-parse", "refs/remotes/origin/main");
};
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const totals = (v: unknown): v is Totals => record(v) && count(v["passed"]) && count(v["failed"]) && count(v["skipped"]);
const summary = (name: string, t: Totals) => `${name}: ${t.passed} passed, ${t.failed} failed, ${t.skipped} skipped`;
const requirePass = (r: { code: number; output: string }) => { if (r.code) throw new Error(r.output.slice(-24_000)); };

/** A report is evidence to inspect, not a cryptographic attestation. Reject malformed or inconsistent records. */
function isReport(v: unknown): v is ReleaseReport {
  if (!record(v) || v["schemaVersion"] !== 1 || typeof v["commit"] !== "string" || !/^[a-f0-9]{40}$/.test(v["commit"])
    || typeof v["remote"] !== "string" || typeof v["startedAt"] !== "string" || typeof v["finishedAt"] !== "string"
    || typeof v["durationMs"] !== "number" || !Number.isFinite(v["durationMs"]) || v["durationMs"] < 0
    || (v["status"] !== "passed" && v["status"] !== "failed") || !record(v["tools"]) || !Object.values(v["tools"]).every((s) => typeof s === "string")
    || !Array.isArray(v["steps"]) || !v["steps"].every((s: unknown) => record(s) && typeof s["name"] === "string" && typeof s["blocking"] === "boolean"
      && (s["status"] === "passed" || s["status"] === "failed") && count(s["exitCode"]) && typeof s["durationMs"] === "number" && Number.isFinite(s["durationMs"]) && s["durationMs"] >= 0)
    || !record(v["tests"]) || !totals(v["tests"]["unit"]) || !totals(v["tests"]["e2e"])
    || !Array.isArray(v["failures"]) || !v["failures"].every((f: unknown) => record(f) && typeof f["step"] === "string" && typeof f["test"] === "string" && typeof f["message"] === "string")
    || (v["limits"] !== undefined && (!Array.isArray(v["limits"]) || !v["limits"].every((s: unknown) => typeof s === "string")))
    || (v["scratchRemoved"] !== undefined && typeof v["scratchRemoved"] !== "boolean")) return false;
  return true;
}
export function parseReport(v: unknown): ReleaseReport {
  if (!isReport(v)) throw new Error("Invalid release report: run release:check again to produce a complete report");
  return v;
}

export async function checkTag(cwd: string, version: string, input: ReleaseReport) {
  const report = parseReport(input);
  const parsed = parseRelease(version);
  if (!parsed || !Object.values(parsed).every(Number.isSafeInteger)) throw new Error("Version must be vX.Y.Z (nonnegative safe integers, no leading zeroes)");
  if (report.status !== "passed" || report.interrupted) throw new Error("Report failed: run release:check and fix its blocking failures before tagging");
  for (const name of BLOCKING) {
    const found = report.steps.filter((s) => s.name === name);
    if (found.length !== 1 || !found[0]?.blocking || found[0].status !== "passed" || found[0].exitCode !== 0) throw new Error(`Report ${name} step is missing or failed: run release:check again`);
  }
  if (report.scratchRemoved !== true) throw new Error("Report does not confirm temporary clone cleanup: run release:check again");
  if (["node", "git", "pnpm", "playwright"].some((name) => !report.tools[name])) throw new Error("Report is missing tool versions: run release:check again");
  if (report.tests.unit.failed || report.tests.e2e.failed || report.tests.unit.passed === 0 || report.tests.e2e.passed === 0) throw new Error("Report contains blocking failures or no executed tests: run release:check again");
  const finished = Date.parse(report.finishedAt);
  const started = Date.parse(report.startedAt);
  if (!Number.isFinite(finished) || !Number.isFinite(started) || started > finished || Date.now() - finished > MAX_AGE_MS) throw new Error("Report must be from the last 24 hours: run release:check again");
  if (finished > Date.now()) throw new Error("Report timestamp is in the future: correct the clock and rerun release:check");
  if (report.remote !== git(cwd, "remote", "get-url", "origin")) throw new Error("Report remote differs from this clone's origin: run release:check against this origin");
  // Refresh the tracking ref and inspect remote tags without importing or replacing local tags.
  const main = fetchMain(cwd);
  if (report.commit !== main) throw new Error(`Report commit sha ${report.commit} differs from current origin/main ${main}: check that commit again`);
  if (git(cwd, "rev-parse", "HEAD") !== main) throw new Error("HEAD differs from current origin/main: use a clone at the checked commit");
  if (git(cwd, "symbolic-ref", "--short", "HEAD") !== "main") throw new Error("A release tag belongs on main: use the main checkout at the checked commit");
  const local = git(cwd, "tag", "--list").split("\n");
  const remote = remoteTags(cwd);
  if ([...local, ...remote].includes(version)) throw new Error(`Tag ${version} already exists locally or on origin: choose a new version; tags are never moved`);
  const newest = newestRelease([...local, ...remote]);
  const newestParsed = newest ? parseRelease(newest) : null;
  if (newestParsed && compare(parsed, newestParsed) <= 0) throw new Error(`Version must be greater than newest tag ${newest}: choose a newer vX.Y.Z`);
  const message = [`Release ${version}`, `Commit: ${main}`, `Checked: ${report.finishedAt}`, summary("Unit", report.tests.unit), summary("E2E (blocking)", report.tests.e2e), ...(report.limits ?? []).map((limit) => `Limit: ${limit}`)].join("\n");
  return { commit: main, message };
}

/** Refresh immediately before publishing; this is a final check, not a lock on the remote. */
export function checkBeforePush(cwd: string, version: string, commit: string, remote: string): void {
  if (remote !== git(cwd, "remote", "get-url", "origin")) throw new Error("Report remote differs from origin before push");
  if (fetchMain(cwd) !== commit) throw new Error("origin/main moved before push: check the new main commit before releasing");
  const tags = remoteTags(cwd);
  if (tags.includes(version)) throw new Error(`Tag ${version} already exists on origin before push`);
  const newest = newestRelease(tags);
  const planned = parseRelease(version);
  const latest = newest ? parseRelease(newest) : null;
  if (!planned || (latest && compare(planned, latest) <= 0)) throw new Error(`A newer release tag ${newest ?? "(invalid version)"} appeared before push: choose a greater version`);
}

/** Do not inherit app state, pnpm configuration, tokens, Node hooks, or git configuration from the calling checkout. */
export function cleanEnvironment(home: string, temp: string, checkout: string, browserPath?: string): NodeJS.ProcessEnv {
  const checkoutRoot = path.resolve(checkout);
  const cleanPath = process.env["PATH"]?.split(path.delimiter).filter((entry) => {
    const absolute = path.resolve(entry);
    return !absolute.split(path.sep).includes("node_modules") && absolute !== checkoutRoot && !absolute.startsWith(checkoutRoot + path.sep);
  }).join(path.delimiter);
  const env: NodeJS.ProcessEnv = {
    PATH: cleanPath, HOME: home, USERPROFILE: home, TMPDIR: temp, TEMP: temp, TMP: temp,
    XDG_CACHE_HOME: path.join(home, ".cache"), XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
    CI: "1", NO_COLOR: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"]) if (process.env[key]) env[key] = process.env[key];
  if (browserPath) {
    const executable = path.resolve(browserPath);
    let directory = path.dirname(executable);
    while (!/^chromium-\d+$/.test(path.basename(directory))) {
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error("--browser-path must point inside a Playwright chromium-<revision> directory. Supply Chromium from a complete cache prepared with pnpm exec playwright install chromium.");
      directory = parent;
    }
    env["GATES_LOCAL_CHROMIUM"] = executable;
    env["PLAYWRIGHT_BROWSERS_PATH"] = path.dirname(directory);
  }
  return env;
}

/** Ask the clone's installed registry for its revisions and platform paths, in the isolated environment. */
export function validateBrowserToolchain(checkout: string, env: NodeJS.ProcessEnv): void {
  const browser = env["GATES_LOCAL_CHROMIUM"];
  if (!browser) return;
  if (!existsSync(browser) || !statSync(browser).isFile()) throw new Error(`Missing supplied Chromium executable: ${browser}. Supply --browser-path from a complete Playwright cache.`);
  const cli = playwrightCommand(checkout)[1];
  if (!cli) throw new Error("Installed Playwright has no Node CLI");
  const playwright = createRequire(cli).resolve("playwright/package.json");
  const registry = createRequire(playwright).resolve("playwright-core/lib/coreBundle");
  // The registry reads browsers.json and PLAYWRIGHT_BROWSERS_PATH at module load.
  // A fresh Node process avoids inheriting a registry cached under the caller's HOME.
  const pieces: unknown = JSON.parse(execFileSync(process.execPath, ["-e",
    'const {registry} = require(process.argv[1]).registry; console.log(JSON.stringify(["chromium-headless-shell", "ffmpeg"].map(name => ({name, executable: registry.findExecutable(name).executablePath()}))));',
    registry,
  ], { cwd: checkout, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  if (!Array.isArray(pieces) || pieces.length !== 2) throw new Error("Installed Playwright did not report its headless shell and ffmpeg paths");
  for (const piece of pieces) {
    if (!record(piece) || typeof piece["name"] !== "string" || typeof piece["executable"] !== "string") throw new Error("Installed Playwright reported an invalid browser toolchain path");
    if (!existsSync(piece["executable"]) || !statSync(piece["executable"]).isFile()) {
      throw new Error(`Missing Playwright ${piece["name"]}: ${piece["executable"]}. Supply --browser-path from a complete cache prepared with PLAYWRIGHT_BROWSERS_PATH set to ${env["PLAYWRIGHT_BROWSERS_PATH"]} and pnpm exec playwright install chromium. A supplied browser never triggers a download during release:check.`);
    }
  }
}

/** Spawn the installed Node CLI itself: pnpm exec can turn a child signal into exit 1. */
function playwrightCommand(clone: string): string[] {
  const local = createRequire(path.join(clone, "package.json"));
  try { return [process.execPath, local.resolve("@playwright/test/cli")]; }
  catch (error) { if (!record(error) || error["code"] !== "MODULE_NOT_FOUND") throw error; }
  const file = local.resolve("playwright/package.json");
  const metadata: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!record(metadata) || !record(metadata["bin"]) || typeof metadata["bin"]["playwright"] !== "string") throw new Error("Installed Playwright has no Node CLI");
  return [process.execPath, path.resolve(path.dirname(file), metadata["bin"]["playwright"])];
}

interface CommandResult { code: number; output: string; completed: boolean; exitCode: number | null; terminationSignal: NodeJS.Signals | null; timedOut: boolean; interrupted?: boolean; treeStillRunning?: true; possibleEscapedDescendants?: true }
const ESCAPED_OUTPUT = "Captured output is still open after the owned group stopped; a descendant outside the owned group may still be running. It was not terminated or confirmed stopped.";
export async function runReleaseCommand(cmd: string[], cwd: string, env: NodeJS.ProcessEnv, log: string, signal?: AbortSignal, timeoutMs?: number): Promise<CommandResult> {
  const [file, ...args] = cmd;
  if (!file) throw new Error("Empty release command");
  if (signal?.aborted) return { code: 130, output: "Release check interrupted", interrupted: true, completed: false, exitCode: null, terminationSignal: null, timedOut: false };
  return new Promise((resolve) => {
    const grouped = process.platform !== "win32";
    const proc = spawn(file, args, { cwd, env, detached: grouped, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let stopping: Promise<boolean> | undefined;
    let settled = false;
    const outputClosed = new Promise<void>(done => proc.once("close", () => done()));
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let timedOut = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const kill = (sig: NodeJS.Signals) => {
      if (!proc.pid) return;
      try { if (grouped) process.kill(-proc.pid, sig); else proc.kill(sig); }
      catch (error) { if (!record(error) || error["code"] !== "ESRCH") output += errorText(error); }
    };
    const goneWithin = async (ms: number) => {
      const until = Date.now() + ms;
      while (proc.pid && (grouped ? groupAlive(proc.pid) : processAlive(proc.pid))) {
        if (Date.now() >= until) return false;
        await new Promise((done) => setTimeout(done, 25));
      }
      return true;
    };
    const stop = async () => {
      kill("SIGTERM");
      if (await goneWithin(2000)) return true;
      kill("SIGKILL");
      return goneWithin(5000);
    };
    const consume = (data: Buffer) => { const s = data.toString(); output += s; appendFileSync(log, s); process.stdout.write(s); };
    const finish = async (code: number | null, terminatedBy: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      const interrupted = stopping !== undefined || signal?.aborted || terminatedBy !== null;
      const ended = stopping === undefined || await stopping;
      signal?.removeEventListener("abort", cancel);
      let possibleEscaped = false;
      if (interrupted && ended && [proc.stdout, proc.stderr].some(stream => !stream.readableEnded && !stream.destroyed)) {
        // Group exit can precede delivery of the pipes' EOF. Wait for close,
        // rather than guessing how many event-loop turns it takes. A writer
        // outside the owned group can keep the pipes open forever, so its
        // lifetime still needs a bound and must be reported as unconfirmed.
        let drainBound: ReturnType<typeof setTimeout> | undefined;
        try {
          possibleEscaped = await Promise.race([
            outputClosed.then(() => false),
            new Promise<boolean>(done => { drainBound = setTimeout(() => done(true), 2000); }),
          ]);
        } finally { clearTimeout(drainBound); }
      }
      if (interrupted) {
        // Another session may hold inherited pipe writers. Its lifetime is
        // outside our group; shutdown confirmation, not EOF, settles cancel.
        proc.stdout.destroy();
        proc.stderr.destroy();
      }
      resolve({ completed: exit !== undefined && exit.signal === null && !timedOut && !signal?.aborted, exitCode: exit?.code ?? null, terminationSignal: exit?.signal ?? null, timedOut, code: interrupted ? 130 : code ?? 128, output: output + (interrupted ? "\nRelease check interrupted" : "") + (ended ? "" : "\nCommand process group could not be confirmed stopped") + (possibleEscaped ? `\n${ESCAPED_OUTPUT}` : ""), interrupted, ...(ended ? {} : { treeStillRunning: true }), ...(possibleEscaped ? { possibleEscapedDescendants: true } : {}) });
    };
    const cancel = () => {
      if (stopping) return;
      stopping = stop().catch((error: unknown) => { output += errorText(error); return false; });
      void stopping.then(() => finish(130, null));
    };
    if (timeoutMs !== undefined) deadline = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    proc.stdout.on("data", consume); proc.stderr.on("data", consume);
    proc.on("error", (error) => { const s = errorText(error); output += s; appendFileSync(log, s); });
    proc.on("exit", (code, terminatedBy) => { exit = { code, signal: terminatedBy }; if (terminatedBy) cancel(); });
    proc.on("close", (code, terminatedBy) => {
      if (terminatedBy) cancel();
      // Closed pipes only prove the leader ended. Keep escalation and confirmation alive for descendants.
      void finish(code, terminatedBy);
    });
  });
}

/** Only the blocking browser report supplies test totals and failures. */
export function readBlockingPlaywright(file: string, report: ReleaseReport): Totals {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!record(raw) || !record(raw["stats"])) throw new Error("Playwright JSON report is missing stats");
  const stats = raw["stats"];
  if (!["expected", "unexpected", "flaky", "skipped"].every(key => count(stats[key]))) throw new Error("Invalid Playwright test totals");
  const visit = (value: unknown, parents: string[] = []) => {
    if (Array.isArray(value)) { value.forEach(item => visit(item, parents)); return; }
    if (!record(value)) return;
    const title = typeof value["title"] === "string" ? [...parents, value["title"]] : parents;
    if (Array.isArray(value["errors"])) for (const error of value["errors"]) {
      report.failures.push({ step: "e2e", test: title.join(" > ") || "Playwright runner", message: record(error) ? String(error["message"] ?? error["value"] ?? "") : String(error) });
    }
    for (const key of ["suites", "specs", "tests", "results"]) visit(value[key], title);
  };
  visit(raw);
  return { passed: Number(stats["expected"]), failed: Number(stats["unexpected"]) + Number(stats["flaky"]), skipped: Number(stats["skipped"]) };
}

export function unitTotals(output: string): Totals {
  const clean = stripVTControlCharacters(output);
  const unitLine = clean.split("\n").findLast((line) => /^\s*Tests\s/.test(line));
  const get = (label: string) => Number(new RegExp(`(\\d+) ${label}`).exec(unitLine ?? "")?.[1] ?? 0);
  if (unitLine) return { passed: get("passed"), failed: get("failed"), skipped: get("skipped") + get("todo") };
  // Also supports the dependency-free node:test fixture used to prove a failing unit command stops the check.
  const nodeCount = (label: string) => Number(new RegExp(`^\\s*(?:#|ℹ)\\s*${label} (\\d+)`, "m").exec(clean)?.[1] ?? 0);
  return { passed: nodeCount("pass"), failed: nodeCount("fail"), skipped: nodeCount("skipped") + nodeCount("todo") };
}

export async function runReleaseCheck(options: CheckOptions): Promise<ReleaseReport> {
  const began = Date.now();
  const reportPath = path.resolve(options.reportPath);
  if (existsSync(reportPath)) throw new Error("Report already exists: choose a new --report path to preserve earlier evidence");
  mkdirSync(path.dirname(reportPath), { recursive: true });
  const artifacts = `${reportPath}.artifacts`;
  mkdirSync(artifacts);
  const report: ReleaseReport = {
    schemaVersion: 1, commit: options.commit ?? "", remote: options.remote ?? "", startedAt: new Date(began).toISOString(), finishedAt: "", durationMs: 0,
    status: "failed", tools: { node: process.version }, steps: [], tests: { unit: emptyTotals(), e2e: emptyTotals() }, failures: [], limits: [],
  };
  // Record limits before any fallible setup, so a failed report still carries them.
  if (options.storeDir) report.limits?.push("A shared pnpm store was selected for installation; a download into an empty store was not proven.");
  if (options.browserPath) report.limits?.push("A supplied Playwright browser cache was shared with the fresh home; installing browsers into an empty cache was not proven.");
  let scratch: string | undefined;
  let active = "setup";
  let cleanupUnsafeReason: string | undefined;
  try {
    report.remote ||= git(options.cwd, "remote", "get-url", "origin");
    report.commit ||= git(options.cwd, "rev-parse", "refs/remotes/origin/main");
    if (!/^[a-f0-9]{40}$/.test(report.commit)) throw new Error("--commit must be a full 40-character commit sha");
    // Keep the isolated home short: tests and Chromium create Unix sockets below it (107-byte limit).
    const base = path.join(homedir(), ".cache", "gl-release");
    mkdirSync(base, { recursive: true });
    scratch = mkdtempSync(path.join(base, "r-"));
    const clone = path.join(scratch, "clone");
    const home = path.join(scratch, "h");
    const temp = path.join(scratch, "t");
    mkdirSync(home); mkdirSync(temp);
    const env = cleanEnvironment(home, temp, options.cwd, options.browserPath);
    const execute = async (argv: string[], cwd: string, log: string, timeoutMs?: number) => {
      const result = await runReleaseCommand(argv, cwd, env, log, options.signal, timeoutMs);
      if (result.treeStillRunning) cleanupUnsafeReason = "command process group could not be confirmed stopped";
      if (result.possibleEscapedDescendants) {
        cleanupUnsafeReason = ESCAPED_OUTPUT;
        report.limits?.push(ESCAPED_OUTPUT);
        report.failures.push({ step: active, test: "process cleanup", message: ESCAPED_OUTPUT });
      }
      return result;
    };
    for (const tool of ["git"]) {
      const r = await execute([tool, "--version"], scratch, path.join(artifacts, "tools.log"));
      if (r.code) throw new Error(`${tool} is unavailable: ${r.output}`);
      report.tools[tool] = r.output.trim();
    }
    const retainResults = (name: string, source: string) => {
      try { if (existsSync(source)) cpSync(source, path.join(artifacts, `${name}-results`), { recursive: true, dereference: true }); }
      catch (error) { report.failures.push({ step: name, test: "retain artifacts", message: errorText(error) }); }
    };
    const step = async (name: string, argv: string[], cwd: string, blocking = true) => {
      active = name;
      const start = Date.now();
      const r = await execute(argv, cwd, path.join(artifacts, `${name}.log`));
      const saved: Step = { name, blocking, status: r.code === 0 ? "passed" : "failed", exitCode: r.code, durationMs: Date.now() - start };
      report.steps.push(saved);
      if (r.interrupted || options.signal?.aborted) {
        if (name === "e2e" && scratch) retainResults(name, path.join(scratch, `${name}-results`));
        throw new Error(`Release check interrupted during ${name}`);
      }
      return { ...r, saved };
    };
    requirePass(await step("clone", ["git", "clone", "--no-local", "--no-checkout", "--", report.remote, clone], scratch));
    requirePass(await step("checkout", ["git", "checkout", "--detach", report.commit], clone));
    const checked = execFileSync("git", ["rev-parse", "HEAD"], { cwd: clone, env, encoding: "utf8" }).trim();
    if (checked !== report.commit) throw new Error("Clone did not check out the requested commit sha");
    requirePass(await step("install", ["pnpm", "install", "--frozen-lockfile", ...(options.storeDir ? ["--store-dir", path.resolve(options.storeDir)] : [])], clone));
    const installedPnpm = await execute(["pnpm", "--version"], clone, path.join(artifacts, "tools.log"));
    requirePass(installedPnpm); report.tools["pnpm"] = installedPnpm.output.trim();
    const pw = await execute(["pnpm", "exec", "playwright", "--version"], clone, path.join(artifacts, "tools.log"));
    report.tools["playwright"] = pw.code === 0 ? pw.output.trim() : "unavailable";
    if (options.browserPath) {
      active = "browser";
      requirePass(pw);
      validateBrowserToolchain(clone, env);
    }
    const verify = await step("verify", ["pnpm", "verify"], clone);
    report.tests.unit = unitTotals(verify.output);
    if (verify.code) {
      const failures = stripVTControlCharacters(verify.output).split(/(?=^[ \t]*FAIL {2,})/m).slice(1).map((s) => s.trim());
      for (const failure of failures) report.failures.push({ step: "verify", test: failure.split("\n")[0]?.trim() ?? "unit", message: failure.slice(0, 24_000) });
    }
    requirePass(verify);
    if (report.tests.unit.passed === 0 || report.tests.unit.failed) throw new Error("verify did not report passing unit tests");
    requirePass(await step("build", ["pnpm", "build"], clone));
    requirePass(await step("desktop-build", ["pnpm", "--filter", "@gates-local/desktop", "build"], clone));
    requirePass(pw);
    const playwright = playwrightCommand(clone);
    // A supplied Playwright cache is validated above and never downloaded here.
    if (!options.browserPath) requirePass(await step("browser", ["pnpm", "exec", "playwright", "install", "chromium"], clone));
    const browserReport = path.join(artifacts, "e2e.json");
    env["PLAYWRIGHT_JSON_OUTPUT_FILE"] = browserReport;
    env["GL_E2E_RESULTS"] = path.join(scratch, "e2e-results");
    env["GL_E2E_DATA_ROOT"] = path.join(scratch, "e2e-data");
    const browser = await step("e2e", [...playwright, "test", "-c", "test/e2e/playwright.config.ts", "--project=e2e", "--forbid-only", "--reporter=list,json"], clone);
    try { report.tests.e2e = readBlockingPlaywright(browserReport, report); }
    finally { if (browser.code || report.failures.length) retainResults("e2e", env["GL_E2E_RESULTS"]); }
    requirePass(browser);
    if (report.tests.e2e.passed === 0 || report.tests.e2e.failed || report.failures.length) throw new Error("Blocking browser project failed; inspect its report and artifacts");

    // Timing is a separate bounded process. Its JSON is never opened here.
    active = "timing";
    const timingReport = path.join(artifacts, "timing.json");
    env["PLAYWRIGHT_JSON_OUTPUT_FILE"] = timingReport;
    env["GL_E2E_RESULTS"] = path.join(scratch, "timing-results");
    env["GL_E2E_DATA_ROOT"] = path.join(scratch, "timing-data");
    report.timing = { completed: false, exitCode: null, reportPath: timingReport };
    try {
      const timing = await execute([...playwright, "test", "-c", "test/e2e/playwright.config.ts", "--project=timing", "--forbid-only", "--reporter=list,json"], clone, path.join(artifacts, "timing.log"), options.timingTimeoutMs ?? 120_000);
      report.timing = { completed: timing.completed, exitCode: timing.exitCode, signal: timing.terminationSignal, timedOut: timing.timedOut, reportPath: timingReport };
    } catch { /* Timing execution errors are informational too. */ }
    if (options.signal?.aborted) throw new Error("Release check interrupted");

    // The enclosing release job holds exclusive browser access throughout.
    // Do not request a nested reservation. Keep outputs outside the disposable clone.
    active = "performance";
    const performanceDir = path.join(artifacts, "performance");
    const inputs = path.join(scratch, "performance-inputs");
    const performance: PerformanceComparison = {
      status: "unavailable", candidate: report.commit, exitCode: null,
      artifacts: performanceDir, reportPath: path.join(performanceDir, "comparison.json"),
      logPath: path.join(artifacts, "performance.log"), rounds: 4, samples: 2,
    };
    report.performance = performance;
    const deadline = Date.now() + (options.performanceTimeoutMs ?? 880_000);
    try {
      mkdirSync(performanceDir);
      writeFileSync(performance.logPath, `Candidate: ${report.commit}\n`, { flag: "wx" });
      const releaseTags = git(clone, "for-each-ref", "--merged", report.commit, "--format=%(refname:strip=2) %(objecttype)", "refs/tags")
        .split("\n").filter(line => line.endsWith(" tag")).map(line => line.slice(0, -4));
      const releaseTag = newestRelease(releaseTags);
      performance.baseSource = releaseTag ? "release" : "fallback";
      if (releaseTag) performance.releaseTag = releaseTag;
      else performance.note = `No previous release tag; using the stated fallback base ${options.performanceBase ?? FIRST_PERFORMANCE_BASE}.`;
      const fallback = options.performanceBase ?? FIRST_PERFORMANCE_BASE;
      if (!releaseTag && !/^[a-f0-9]{40}$/.test(fallback)) throw new Error("--performance-base must be a full 40-character commit sha; measurements unavailable.");
      performance.base = releaseTag ? git(clone, "rev-parse", "--verify", `refs/tags/${releaseTag}^{commit}`) : fallback;
      git(clone, "rev-parse", "--verify", `${performance.base}^{commit}`);
      appendFileSync(performance.logPath, `Base: ${performance.base} (${performance.baseSource}${releaseTag ? ` ${releaseTag}` : ""})\n`);
      const commands = [
        ["pnpm", "perf:compare", "--prepare", performance.base, report.commit, "--out", inputs],
        ["pnpm", "perf:compare", "--prepared", inputs, "--rounds", String(performance.rounds), "--samples", String(performance.samples), "--out", performanceDir],
      ];
      for (const command of commands) {
        const result = await execute(command, clone, performance.logPath, Math.max(1, deadline - Date.now()));
        performance.exitCode = result.exitCode;
        performance.signal = result.terminationSignal;
        performance.timedOut = result.timedOut;
        if (!result.completed || result.code) throw new Error(`Comparison command failed (${result.exitCode ?? result.terminationSignal ?? "no exit"}${result.timedOut ? "; timed out" : ""}); measurements unavailable.`);
      }
      const measured: unknown = JSON.parse(readFileSync(performance.reportPath, "utf8"));
      if (!record(measured) || measured["schema"] !== 1 || measured["informational"] !== true || !record(measured["commits"])
        || measured["commits"]["base"] !== performance.base || measured["commits"]["candidate"] !== report.commit
        || !existsSync(path.join(performanceDir, "comparison.md"))) throw new Error("Comparison outputs are missing, invalid, or name different commits; measurements unavailable.");
      performance.status = "available";
    } catch (error) {
      performance.note = [performance.note, errorText(error)].filter(Boolean).join(" ");
    }
    if (options.signal?.aborted) throw new Error("Release check interrupted");
    report.status = "passed";
  } catch (error) {
    if (options.signal?.aborted) { report.interrupted = true; active = "interrupted"; }
    report.failures.push({ step: active, test: "command", message: errorText(error) });
    const existing = report.steps.findLast((s) => s.name === active);
    if (existing) existing.status = "failed";
    else report.steps.push({ name: active, blocking: true, status: "failed", exitCode: 1, durationMs: Date.now() - began });
  } finally {
    if (scratch && cleanupUnsafeReason) {
      report.status = "failed";
      report.scratchRemoved = false;
      report.failures.push({ step: "cleanup", test: "command", message: `Temporary data retained at ${scratch}: ${cleanupUnsafeReason}` });
    } else if (scratch) {
      try { rmSync(scratch, { recursive: true, force: true }); report.scratchRemoved = true; }
      catch (error) { report.status = "failed"; report.failures.push({ step: "cleanup", test: "scratch", message: errorText(error) }); }
    }
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - began;
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  }
  return report;
}
