// Puts each mistake in test/mistakes back into today's code, one at a time, and
// says which check stops it first: typecheck, lint, the models (without their
// "file changed since it was read" guard), the unit tests that import the touched files,
// then the whole unit suite. A mistake no layer stops "got through". A mistake
// whose record says only a browser shows it, and that no layer stops, is "not
// judged here": these layers cannot see it, and the browser suite is not run.
//
// Every patch is applied in a scratch worktree, never in this checkout. The run
// refuses to start if any patch no longer applies, naming each one. A unit catch
// is confirmed twice: the red files run again with the patch (a red that goes
// away is flake) and without it (a red that stays is a broken test). Either
// way the row counts as noise, not a catch.
//
//   node scripts/mistakes.ts                       every patch
//   node scripts/mistakes.ts --only B044,B076      these patches
//   --tree <dir>    scratch worktree (default ~/.cache/gates-local-mistakes/tree; made if missing)
//   --out <file>    the reading (default test/mistakes/reading.json)
//
// Run it pinned to the cores it may use, e.g. `taskset -c 8-19 node scripts/mistakes.ts`.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIR = path.join(ROOT, "test/mistakes");
const USAGE = "usage: node scripts/mistakes.ts [--only id,id] [--tree dir] [--out file]";

const LAYERS = ["typecheck", "lint", "model-check", "unit (related)", "unit (whole)"] as const;
type Layer = (typeof LAYERS)[number];
const MINUTES = 60_000;
const LIMIT: Record<Layer, number> = { typecheck: 5 * MINUTES, lint: 5 * MINUTES, "model-check": 10 * MINUTES, "unit (related)": 20 * MINUTES, "unit (whole)": 30 * MINUTES };

// why: these flag the edit's own spelling (if (false), dead code after it), not what it breaks
const ARTIFACT_RULES = new Set(["no-constant-condition", "no-constant-binary-expression", "no-unreachable", "consistent-function-scoping"]);

interface Mistake { id: string; klass: string; fix: string; browser: boolean; seen: string; file: string; touched: string[] }
interface Red { file: string; test: string }
type Verdict =
  | { kind: "caught"; layer: Layer; detail: string; rules?: string[] }
  | { kind: "through" }
  | { kind: "not judged here"; red?: string }
  | { kind: "noise"; layer: Layer; detail: string };
interface Row { id: string; class: string; fix: string; browser: boolean; seen: string; verdict: Verdict; seconds: number }

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value\n${USAGE}`);
  return v;
}

function readMistake(file: string): Mistake {
  const text = readFileSync(path.join(DIR, file), "utf8");
  const head = new Map<string, string>();
  for (const line of text.slice(0, text.indexOf("\ndiff --git ")).split("\n")) {
    const m = /^(\w+): (.*)$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) head.set(m[1], m[2]);
  }
  const need = (key: string): string => {
    const v = head.get(key);
    if (v === undefined) throw new Error(`${file}: no ${key}: line in its header`);
    return v;
  };
  const touched = [...text.matchAll(/^diff --git a\/(\S+) b\//gm)].flatMap(m => (m[1] === undefined ? [] : [m[1]]));
  if (touched.length === 0) throw new Error(`${file}: no diff`);
  return { id: need("Mistake"), klass: need("Class"), fix: need("Fix"), browser: need("Browser") === "yes", seen: need("Seen"), file: path.join(DIR, file), touched };
}

function git(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.trim() };
}

/**
 * Drops terminal colour codes. Without a terminal in its environment, oxlint
 * colours its report even with NO_COLOR set, which hid every stock rule name
 * from lintRules (seen 2026-11-21 under a systemd unit).
 */
const ESCAPES = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (text: string) => text.replace(ESCAPES, "");

/** Runs a command in its own process group and ends the whole group at the limit. */
function run(cwd: string, command: string, args: string[], limitMs: number): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", CI: "1" } });
    let out = "";
    const keep = (chunk: Buffer) => { out = (out + chunk.toString("utf8")).slice(-400_000); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    let timedOut = false;
    // oxlint-disable-next-line gates/timer-needs-reason -- the step's time limit; a hung step ends the row
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }, limitMs);
    child.on("error", e => { clearTimeout(timer); resolve({ code: null, out: plain(out) + e.message, timedOut }); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, out: plain(out), timedOut }); });
  });
}

/** Rule names in lint's output: stock oxlint rules, project rules that rose, and project rules that only fell. */
function lintRules(text: string): { stock: Set<string>; rose: Set<string>; fell: Set<string> } {
  const scopes = "(?:eslint|typescript|unicorn|import|react|react-perf|jsx-a11y|oxc|vitest|jest|promise|node|jsdoc|regexp)";
  const stock = new Set([...text.matchAll(new RegExp(`(?:error |warning |× |⚠ |! )${scopes}\\(([\\w-]+)\\):`, "g"))].flatMap(m => (m[1] === undefined ? [] : [m[1]])));
  const rose = new Set<string>();
  const fell = new Set<string>();
  let section: "rose" | "fell" | "other" | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("Project rules: new offenders")) section = "rose";
    else if (line.startsWith("Project rules:") && line.includes("higher than the code now has")) section = "fell";
    else if (line.startsWith("Project rules:")) section = "other";
    else if (section === "rose") { const m = /^([\w-]+\/[\w-]+)(?::|$)/.exec(line); if (m?.[1] !== undefined) rose.add(m[1]); }
    else if (section === "fell") { const m = /^ {2}([\w-]+\/[\w-]+) {2}/.exec(line); if (m?.[1] !== undefined) fell.add(m[1]); }
  }
  return { stock, rose, fell };
}

interface VitestJson { testResults?: { name: string; status: string; message?: string; assertionResults?: { status: string; fullName?: string; title?: string }[] }[] }

/** Runs vitest with a JSON report and returns its red tests, a load failure counting as one red for the file. */
async function vitest(tree: string, args: string[], limitMs: number): Promise<{ reds: Red[]; timedOut: boolean }> {
  const report = path.join(tree, "node_modules/.mistakes-vitest.json");
  const started = Date.now();
  const r = await run(tree, path.join(tree, "node_modules/.bin/vitest"), [...args, "--reporter=json", `--outputFile=${report}`], limitMs);
  const reds: Red[] = [];
  // why: a run that died before writing leaves the last run's report; only a fresh one is read
  if (existsSync(report) && statSync(report).mtimeMs >= started) {
    const parsed = JSON.parse(readFileSync(report, "utf8")) as VitestJson;
    for (const t of parsed.testResults ?? []) {
      const file = path.relative(tree, t.name);
      const failed = (t.assertionResults ?? []).filter(a => a.status === "failed");
      if (failed.length > 0) reds.push(...failed.map(a => ({ file, test: a.fullName ?? a.title ?? "" })));
      else if (t.status === "failed") reds.push({ file, test: `(file failed: ${(t.message ?? "").split("\n")[0] ?? ""})` });
    }
  }
  // why: an unhandled error fails the run with no red test; it still counts, under one fixed name
  if (r.code !== 0 && !r.timedOut && reds.length === 0) reds.push({ file: "(vitest)", test: "exited non-zero with no red test" });
  return { reds, timedOut: r.timedOut };
}

const key = (red: Red) => `${red.file}\n${red.test}`;

/** Prepares the scratch worktree at this checkout's commit, with packages installed. */
function prepare(tree: string): void {
  const head = git(ROOT, "rev-parse", "HEAD").out;
  if (!existsSync(tree)) {
    mkdirSync(path.dirname(tree), { recursive: true });
    const made = git(ROOT, "worktree", "add", "--detach", tree, head);
    if (!made.ok) throw new Error(`could not make the scratch worktree: ${made.out}`);
  }
  if (git(tree, "status", "--porcelain", "--untracked-files=all").out !== "") throw new Error(`the scratch worktree ${tree} has changes; clean it or pass another --tree`);
  if (git(tree, "rev-parse", "HEAD").out !== head) {
    const moved = git(tree, "checkout", "--detach", head);
    if (!moved.ok) throw new Error(`could not move the scratch worktree to ${head}: ${moved.out}`);
  }
  if (!existsSync(path.join(tree, "node_modules/.bin/vitest"))) {
    const r = spawnSync("pnpm", ["install", "--offline", "--frozen-lockfile"], { cwd: tree, stdio: "inherit" });
    if (r.status !== 0) throw new Error("pnpm install in the scratch worktree failed");
  }
}

function restore(tree: string, m: Mistake): void {
  const back = git(tree, "apply", "-R", m.file);
  const left = git(tree, "status", "--porcelain", "--untracked-files=all").out;
  if (!back.ok || left !== "") throw new Error(`${m.id}: the scratch worktree is not clean after restoring it\n${back.out}\n${left}`);
}

/** A browser row is never counted as caught; a red layer is kept beside it as a note. */
async function judge(tree: string, m: Mistake, knownReds: ReadonlySet<string>): Promise<Verdict> {
  const v = await layers(tree, m, knownReds);
  if (!m.browser) return v;
  return v.kind === "caught" || v.kind === "noise" ? { kind: "not judged here", red: `${v.kind} at ${v.layer}: ${v.detail}` } : { kind: "not judged here" };
}

async function layers(tree: string, m: Mistake, knownReds: ReadonlySet<string>): Promise<Verdict> {
  const applied = git(tree, "apply", m.file);
  if (!applied.ok) throw new Error(`${m.id}: patch no longer applies\n${applied.out}`);
  let unitReds: Red[] = [];
  let unitLayer: Layer = "unit (related)";
  let flaky: Red[] = [];
  try {
    const types = await run(tree, "pnpm", ["typecheck"], LIMIT.typecheck);
    if (types.code !== 0) {
      const first = types.out.split("\n").find(l => /error TS\d+/.test(l)) ?? (types.timedOut ? "timed out" : "failed");
      return { kind: "caught", layer: "typecheck", detail: first.trim() };
    }
    const lint = await run(tree, "pnpm", ["lint"], LIMIT.lint);
    if (lint.code !== 0) {
      const { stock, rose, fell } = lintRules(lint.out);
      const behaviour = [...stock].filter(r => !ARTIFACT_RULES.has(r)).concat([...rose]);
      if (behaviour.length > 0) return { kind: "caught", layer: "lint", detail: behaviour.join(", "), rules: behaviour };
      if (stock.size === 0 && rose.size === 0 && fell.size === 0) {
        const lines = lint.out.trim().split("\n");
        const first = lines.find(l => /\berror\b|×/i.test(l) && !l.includes("ELIFECYCLE")) ?? lines.at(-1) ?? "";
        return { kind: "caught", layer: "lint", detail: `lint failed for a reason this runner does not parse: ${first.trim()}` };
      }
    }
    // why: every patch to a hand-modelled file trips the "changed since it was read" guard, whatever the patch does; counted as a catch it hid t13 getting through (2026-11-22)
    const model = await run(tree, "node", ["scripts/model-check.ts", "--as-read"], LIMIT["model-check"]);
    if (model.code !== 0) return { kind: "caught", layer: "model-check", detail: model.out.trim().split("\n").at(-1) ?? "" };
    const related = await vitest(tree, ["related", "--run", "--passWithNoTests", ...m.touched], LIMIT["unit (related)"]);
    unitReds = related.reds.filter(r => !knownReds.has(key(r)));
    if (unitReds.length === 0 && !related.timedOut) {
      unitLayer = "unit (whole)";
      const whole = await vitest(tree, ["run"], LIMIT["unit (whole)"]);
      unitReds = whole.reds.filter(r => !knownReds.has(key(r)));
      if (whole.timedOut) unitReds.push({ file: "(whole suite)", test: "timed out" });
    } else if (related.timedOut) unitReds.push({ file: "(related tests)", test: "timed out" });
    // why: a red that does not come back when its file runs again with the mistake still in is load flake (n01, 2026-11-21)
    const redFiles = [...new Set(unitReds.map(r => r.file).filter(f => !f.startsWith("(")))];
    const rerun = redFiles.length > 0 ? await vitest(tree, ["run", ...redFiles], LIMIT["unit (related)"]) : undefined;
    if (rerun !== undefined && !rerun.timedOut) {
      const repeat = new Set(rerun.reds.map(key));
      flaky = unitReds.filter(r => !r.file.startsWith("(") && !repeat.has(key(r)));
      unitReds = unitReds.filter(r => r.file.startsWith("(") || repeat.has(key(r)));
    }
  } finally {
    restore(tree, m);
  }
  if (unitReds.length === 0 && flaky.length > 0) return { kind: "noise", layer: unitLayer, detail: `${flaky[0]?.file ?? ""} > ${flaky[0]?.test ?? ""} (red once, green when run again with the mistake in)` };
  if (unitReds.length === 0) return { kind: "through" };
  const first = unitReds[0] ?? { file: "", test: "" };
  const detail = `${first.file} > ${first.test}${unitReds.length > 1 ? ` (+${unitReds.length - 1} more)` : ""}`;
  const files = [...new Set(unitReds.map(r => r.file).filter(f => !f.startsWith("(")))];
  if (files.length === 0) return { kind: "caught", layer: unitLayer, detail };
  // why: a red that is also red on the clean tree is a flaky or broken test, not this mistake's catch
  const again = await vitest(tree, ["run", ...files], LIMIT["unit (related)"]);
  const still = new Set(again.reds.map(key));
  const real = unitReds.filter(r => !still.has(key(r)));
  if (real.length === 0) return { kind: "noise", layer: unitLayer, detail };
  const shown = real[0] ?? first;
  return { kind: "caught", layer: unitLayer, detail: `${shown.file} > ${shown.test}${real.length > 1 ? ` (+${real.length - 1} more)` : ""}` };
}

function table(rows: readonly Row[], noPlace: ReadonlyMap<string, number>): string {
  const classes = [...new Set([...rows.map(r => r.class), ...noPlace.keys()])].toSorted((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const head = ["class", "planted", ...LAYERS, "through", "not judged here", "noise", "no place left"];
  const line = (name: string, of: readonly Row[], none: number) => {
    const layer = (l: Layer) => of.filter(r => r.verdict.kind === "caught" && r.verdict.layer === l).length;
    const count = (k: Verdict["kind"]) => of.filter(r => r.verdict.kind === k).length;
    return [name, of.length, ...LAYERS.map(layer), count("through"), count("not judged here"), count("noise"), none].map(String);
  };
  const body = classes.map(c => line(c, rows.filter(r => r.class === c), noPlace.get(c) ?? 0));
  const census = rows.filter(r => r.fix !== "planted");
  const planted = rows.filter(r => r.fix === "planted");
  const sum = [...noPlace.values()].reduce((a, b) => a + b, 0);
  const all = [head, ...body, line("census", census, sum), line("planted", planted, 0), line("all", rows, sum)];
  const widths = head.map((_, i) => Math.max(...all.map(r => (r[i] ?? "").length)));
  const judged = rows.filter(r => r.verdict.kind === "caught" || r.verdict.kind === "through");
  const through = judged.filter(r => r.verdict.kind === "through").length;
  const rate = judged.length === 0 ? "none judged" : `${through} of ${judged.length} judged got through (${Math.round((100 * through) / judged.length)}%)`;
  return `${all.map(r => r.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ")).join("\n")}\n\n${rate}`;
}

async function main(): Promise<void> {
  const only = arg("--only")?.split(",");
  const tree = path.resolve(arg("--tree") ?? path.join(homedir(), ".cache/gates-local-mistakes/tree"));
  const out = path.resolve(arg("--out") ?? path.join(DIR, "reading.json"));
  const all = readdirSync(DIR).filter(f => f.endsWith(".patch")).toSorted().map(readMistake);
  const unknown = (only ?? []).filter(id => !all.some(m => m.id === id));
  if (unknown.length > 0) throw new Error(`no such mistake: ${unknown.join(", ")}`);
  const mistakes = only === undefined ? all : all.filter(m => only.includes(m.id));

  prepare(tree);
  const stale = mistakes.flatMap(m => { const r = git(tree, "apply", "--check", m.file); return r.ok ? [] : [`${m.id} (${path.relative(ROOT, m.file)}): ${r.out}`]; });
  if (stale.length > 0) {
    console.error(`STALE: ${stale.length} mistake patch${stale.length === 1 ? "" : "es"} no longer appl${stale.length === 1 ? "ies" : "y"} to today's code. Update or retire each one:\n${stale.join("\n")}`);
    process.exit(1);
  }

  console.log("clean tree: typecheck, lint and the whole unit suite, to know what is red before any mistake");
  for (const [layer, command] of [["typecheck", ["typecheck"]], ["lint", ["lint"]]] as const) {
    const r = await run(tree, "pnpm", [...command], LIMIT[layer]);
    if (r.code !== 0) throw new Error(`${layer} fails on the clean tree; nothing can be judged\n${r.out.slice(-2000)}`);
  }
  const base = await vitest(tree, ["run"], LIMIT["unit (whole)"]);
  if (base.timedOut) throw new Error("the whole unit suite timed out on the clean tree");
  const knownReds = new Set(base.reds.map(key));
  if (knownReds.size > 0) console.log(`red without any mistake (not counted as catches):\n${base.reds.map(r => `  ${r.file} > ${r.test}`).join("\n")}`);

  const rows: Row[] = [];
  for (const m of mistakes) {
    const started = performance.now();
    const verdict = await judge(tree, m, knownReds);
    const row: Row = { id: m.id, class: m.klass, fix: m.fix, browser: m.browser, seen: m.seen, verdict, seconds: Math.round((performance.now() - started) / 1000) };
    rows.push(row);
    const where = verdict.kind === "caught" || verdict.kind === "noise" ? ` ${verdict.layer}: ${verdict.detail}`
      : verdict.kind === "not judged here" && verdict.red !== undefined ? ` (${verdict.red})` : "";
    console.log(`${m.id.padEnd(5)} ${m.klass.padEnd(4)} ${verdict.kind}${where} (${row.seconds} s)`);
  }

  const noPlace = new Map<string, number>();
  const tsv = path.join(DIR, "no-place-left.tsv");
  if (only === undefined && existsSync(tsv)) {
    for (const line of readFileSync(tsv, "utf8").split("\n").slice(1).filter(l => l.trim() !== "")) {
      const klass = line.split("\t")[1] ?? "?";
      noPlace.set(klass, (noPlace.get(klass) ?? 0) + 1);
    }
  }
  const head = git(tree, "rev-parse", "--short", "HEAD").out;
  const shown = table(rows, noPlace);
  writeFileSync(out, `${JSON.stringify({ head, date: new Date().toISOString().slice(0, 10), only: only ?? null, table: shown.split("\n"), rows }, null, 2)}\n`);
  console.log(`\n${shown}\n\nreading: ${path.relative(ROOT, out)}`);
}

await main();
