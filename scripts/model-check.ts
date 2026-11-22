// `node scripts/model-check.ts [model ...]`: checks the formal models in model/ against the product code.
// The true model of each must pass, every replay of a past bug must FAIL, and a file a model was
// written from by hand must be unchanged since the model was last read against it.
// `--confirm <model>` records that reading. Needs Java and the TLA+ tools jar; says what to install when either is missing.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MODELS, type Model, type Setting } from "../model/models.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const JAR = {
  version: "1.7.4",
  url: "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar",
  sha256: "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
  home: "model/.tools/tla2tools.jar",
};
const JAVA_AT_LEAST = 11;
const VIOLATED = 12;

const problems: string[] = [];
const say = (line = ""): void => { console.log(line); };
const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

function findJava(): string {
  const home = process.env["JAVA_HOME"];
  const tried = [...(home === undefined || home === "" ? [] : [path.join(home, "bin", "java")]), "java"];
  for (const java of tried) {
    const r = spawnSync(java, ["-version"], { encoding: "utf8" });
    const found = /version "(\d+)(?:\.(\d+))?/.exec(`${r.stderr ?? ""}${r.stdout ?? ""}`);
    if (r.status !== 0 || found === null) continue;
    const major = found[1] === "1" ? Number(found[2]) : Number(found[1]);
    if (major >= JAVA_AT_LEAST) return java;
    throw new Error(`${java} is Java ${major}. The models need Java ${JAVA_AT_LEAST} or newer: install a JDK (OpenJDK 17 is what this was built with) or point JAVA_HOME at one.`);
  }
  throw new Error(`Java was not found (tried ${tried.join(", ")}). Install a JDK, version ${JAVA_AT_LEAST} or newer (OpenJDK 17 is what this was built with), or point JAVA_HOME at one.`);
}

function findJar(): string {
  const asked = process.env["TLA2TOOLS_JAR"];
  const mise = path.join(process.env["XDG_DATA_HOME"] ?? path.join(os.homedir(), ".local", "share"), "mise", "installs", "http-tla2tools");
  const places = [
    ...(asked === undefined || asked === "" ? [] : [asked]),
    path.join(ROOT, JAR.home),
    ...(existsSync(mise) ? readdirSync(mise).map((version) => path.join(mise, version, "tla2tools.jar")) : []),
  ];
  const wrong: string[] = [];
  for (const jar of places) {
    if (!existsSync(jar)) continue;
    const sum = sha256(jar);
    if (sum === JAR.sha256) return jar;
    wrong.push(`  ${jar} has sha256 ${sum}, which is not that version.`);
  }
  throw new Error([
    `The TLA+ tools jar, version ${JAR.version}, was not found.`,
    ...wrong,
    `  Download ${JAR.url}`,
    `  to ${JAR.home} (git ignores it), or set TLA2TOOLS_JAR to where it is.`,
    `  Its sha256 must be ${JAR.sha256}.`,
  ].join("\n"));
}

// ---- the files a model was written from by hand ----

interface Confirmed { readonly commit: string; readonly files: Readonly<Record<string, string>> }
const coveredFile = (m: Model): string => path.join(ROOT, "model", m.name, "covered.json");
const hashes = (m: Model): Record<string, string> => Object.fromEntries(Object.keys(m.covered).toSorted().map((f) => [f, sha256(path.join(ROOT, f))]));

const git = (args: readonly string[]): string => spawnSync("git", args, { cwd: ROOT, encoding: "utf8" }).stdout.trim();

function confirm(m: Model): void {
  const edited = git(["status", "--porcelain", "--", ...Object.keys(m.covered)]) !== "";
  const confirmed: Confirmed = { commit: `${git(["rev-parse", "--short=8", "HEAD"])}${edited ? " with changes not yet committed" : ""}`, files: hashes(m) };
  writeFileSync(coveredFile(m), `${JSON.stringify(confirmed, null, 2)}\n`);
  say(`${m.name}: recorded ${Object.keys(m.covered).length} files as read against the model at ${confirmed.commit}.`);
}

/** Says which hand-modelled files changed since the model was confirmed, and how to confirm it again. */
function drift(m: Model): string {
  const again = `Read model/${m.name}/README.md, bring model/${m.name}/${m.spec}.tla in line with the file, then run: node scripts/model-check.ts --confirm ${m.name}`;
  if (!existsSync(coveredFile(m))) {
    problems.push(`${m.name}: model/${m.name}/covered.json is missing, so nothing says this model was read against the code. ${again}`);
    return "not confirmed";
  }
  const was = JSON.parse(readFileSync(coveredFile(m), "utf8")) as Confirmed;
  const now = hashes(m);
  const changed = [...new Set([...Object.keys(now), ...Object.keys(was.files)])].filter((f) => now[f] !== was.files[f]);
  for (const f of changed) {
    const what = now[f] === undefined ? "is no longer listed for this model in model/models.ts" : was.files[f] === undefined ? "is new in this model's list in model/models.ts" : "changed";
    problems.push(`${m.name}: ${f} ${what} since the model was read against it at ${was.commit} (it stands for: ${m.covered[f] ?? "nothing now"}). ${again}`);
  }
  return changed.length === 0 ? `unchanged since ${was.commit}` : `${changed.length} CHANGED since ${was.commit}`;
}

// ---- running TLC ----

interface Job { readonly model: Model; readonly run: string; readonly set: Readonly<Record<string, string>>; readonly invariants: readonly string[] }
interface Ran { readonly code: number; readonly out: string; readonly generated: number; readonly distinct: number; readonly violated: string | undefined; readonly trace: readonly State[] }
interface State { readonly action: string; readonly line: number; readonly values: ReadonlyMap<string, string> }

const outDir = (m: Model): string => path.join(ROOT, "model", ".out", m.name);

function tlc(java: string, jar: string, job: Job): Promise<Ran> {
  const dir = outDir(job.model);
  const tmp = path.join(dir, "tmp", job.run);
  mkdirSync(tmp, { recursive: true });
  const constants = { ...job.model.constants, ...job.set };
  writeFileSync(path.join(dir, `${job.run}.cfg`), [
    "SPECIFICATION Spec", "CONSTANTS", ...Object.entries(constants).map(([k, v]) => `  ${k} = ${v}`), "INVARIANTS", ...job.invariants.map((i) => `  ${i}`), "",
  ].join("\n"));
  const args = [
    // external: TLC unpacks its standard modules into Java's temp folder, which is the machine's shared one unless told.
    "-XX:+UseParallelGC", "-Xmx2g", `-Djava.io.tmpdir=${tmp}`, "-cp", jar, "tlc2.TLC",
    "-config", `${job.run}.cfg`, "-metadir", path.join(dir, "states", job.run), "-workers", "2",
    ...(job.model.deadlock ? [] : ["-deadlock"]), `${job.model.spec}.tla`,
  ];
  return new Promise((resolve) => {
    const child = spawn(java, args, { cwd: dir });
    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("close", (code) => {
      writeFileSync(path.join(dir, `${job.run}.out`), out);
      const counted = /(\d+) states generated, (\d+) distinct states found/.exec(out);
      const violated = /Error: Invariant (\w+) is violated/.exec(out)?.[1] ?? (out.includes("Error: Deadlock reached") ? "deadlock" : undefined);
      resolve({ code: code ?? -1, out, generated: Number(counted?.[1] ?? 0), distinct: Number(counted?.[2] ?? 0), violated, trace: traceOf(out) });
    });
  });
}

function traceOf(out: string): State[] {
  const states: State[] = [];
  let values = new Map<string, string>();
  let name = "";
  for (const line of out.split("\n")) {
    const head = /^State \d+: <(\w+)(?: line (\d+),)?/.exec(line);
    if (head !== null) {
      values = new Map();
      states.push({ action: head[1] === "Initial" ? "Init" : head[1]!, line: Number(head[2] ?? 0), values });
      continue;
    }
    if (states.length === 0) continue;
    const first = /^\/\\ (\w+) = (.*)$/.exec(line);
    if (first !== null) { name = first[1]!; values.set(name, first[2]!); }
    else if (line.trim() === "") name = "";
    else if (name !== "") values.set(name, `${values.get(name)} ${line.trim()}`);
  }
  return states;
}

// ---- telling a counterexample in the code's words ----

/** Splits a TLC value on `sep` where no bracket or string is open. */
function splitTop(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0, from = 0, quoted = false;
  for (let i = 0; i < s.length; i++) {
    const two = s.slice(i, i + 2);
    if (s[i] === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (two === "<<" || two === ">>") { depth += two === "<<" ? 1 : -1; i += 1; }
    else if ("[({".includes(s[i]!)) depth += 1;
    else if ("])}".includes(s[i]!)) depth -= 1;
    else if (depth === 0 && s.startsWith(sep, i)) { parts.push(s.slice(from, i)); from = i + sep.length; i = from - 1; }
  }
  return [...parts, s.slice(from)];
}

/** A record or function becomes one entry for each of its keys, so a step shows only the keys it changed. */
function leaves(at: string, value: string, into: Map<string, string>): void {
  const v = value.trim();
  const record = v.startsWith("[") && v.endsWith("]") ? splitTop(v.slice(1, -1), ", ").map((p) => splitTop(p, " |-> ")) : [];
  const fn = v.startsWith("(") && v.endsWith(")") ? splitTop(v.slice(1, -1), " @@ ").map((p) => splitTop(p, " :> ")) : [];
  const pairs = record.length > 0 && record.every((p) => p.length === 2) ? record : fn.length > 0 && fn.every((p) => p.length === 2) ? fn : null;
  if (pairs === null) into.set(at, v);
  else for (const [k, inner] of pairs) leaves(`${at}.${k!.trim()}`, inner!, into);
}

/** Each step as the action, the comment above its definition (which names the code), and what it changed. */
function told(m: Model, trace: readonly State[]): string[] {
  const spec = readFileSync(path.join(ROOT, "model", m.name, `${m.spec}.tla`), "utf8").split("\n");
  const lines: string[] = [];
  let before = new Map<string, string>();
  trace.forEach((state, i) => {
    const now = new Map<string, string>();
    for (const [k, v] of state.values) leaves(k, v, now);
    if (i === 0) lines.push("1. Start: nothing has happened yet.");
    else {
      let def = Math.min(state.line, spec.length) - 1;
      while (def > 0 && !new RegExp(`^${state.action}(\\(|\\s*==)`).test(spec[def]!)) def -= 1;
      // The comment may stand above an earlier definition of the same paragraph (a pair like MergeBegins, MergeEnds).
      let end = def;
      while (end > 0 && spec[end - 1]!.trim() !== "" && !spec[end - 1]!.startsWith("\\*")) end -= 1;
      let top = end;
      while (top > 0 && spec[top - 1]!.startsWith("\\*")) top -= 1;
      lines.push(`${i + 1}. ${state.action}  (model/${m.name}/${m.spec}.tla:${def + 1})`);
      for (const c of spec.slice(top, end)) lines.push(`     ${c.replace(/^\\\*\s?/, "")}`);
      for (const [k, v] of now) if (before.get(k) !== v) lines.push(`       ${k}: ${before.get(k) ?? "nothing"} -> ${v}`);
    }
    before = now;
  });
  return lines;
}

// ---- one model ----

const thousands = (n: number): string => n.toLocaleString("en-US");

/** Runs the jobs a few at a time: each is its own Java process. */
async function pool<T, R>(items: readonly T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await work(items[i]!); }
  }));
  return results;
}

/** A run that must fail is given only the rule it must break, so no other rule can fail in its place. */
const only = (fails: string): string[] => [...new Set(["TypeOK", fails])];

async function check(m: Model, java: string, jar: string, width: number): Promise<number> {
  say(`${m.name}`);
  say(`  bounds and switches: ${Object.entries(m.constants).map(([k, v]) => `${k} = ${v}`).join(", ")}`);
  const dir = outDir(m);
  mkdirSync(dir, { recursive: true });
  copyFileSync(path.join(ROOT, "model", m.name, `${m.spec}.tla`), path.join(dir, `${m.spec}.tla`));
  try {
    for (const t of await m.tables()) {
      writeFileSync(path.join(dir, `${t.module}.tla`), t.text);
      say(`  read from the code: ${t.read}`);
    }
  } catch (e) {
    problems.push(`${m.name}: the code no longer fits the model's table. ${e instanceof Error ? e.message : String(e)}`);
    say("  read from the code: FAILED, see below");
    return 0;
  }
  say(`  written by hand from ${Object.keys(m.covered).length} files: ${drift(m)}`);

  const trueRuns: Setting[] = [{ name: "true", set: {} }, ...m.also];
  const jobs: Job[] = [
    ...trueRuns.map((s) => ({ model: m, run: s.name, set: s.set, invariants: m.invariants })),
    ...m.replays.map((r) => ({ model: m, run: `replay-${r.name}`, set: r.set, invariants: only(r.fails) })),
    ...m.findings.map((f) => ({ model: m, run: `open-${f.name}`, set: f.set, invariants: only(f.fails) })),
  ];
  const ran = await pool(jobs, width, (job) => tlc(java, jar, job));
  const of = (run: string): Ran => ran[jobs.findIndex((j) => j.run === run)]!;
  const save = (run: string, head: readonly string[], r: Ran): string => {
    const file = path.join(dir, `${run}.trace.txt`);
    writeFileSync(file, [...head, "", ...told(m, r.trace), ""].join("\n"));
    return path.relative(ROOT, file);
  };

  for (const s of trueRuns) {
    const r = of(s.name);
    const label = s.name === "true" ? "the model" : `the model with ${Object.entries(s.set).map(([k, v]) => `${k} = ${v}`).join(", ")}`;
    if (r.code === 0) say(`  ${label}: passed, ${thousands(r.generated)} states checked (${thousands(r.distinct)} distinct)`);
    else if (r.code === VIOLATED && r.violated !== undefined) {
      const file = save(s.name, [`${m.name}: ${r.violated} is broken.`], r);
      say(`  ${label}: FAILED, ${r.violated} is broken`);
      problems.push([
        `${m.name}: ${r.violated} is broken by the code as it is now. The steps (also in ${file}):`,
        ...told(m, r.trace).map((l) => `    ${l}`),
        `  A real bug or a modelling error? .claude/skills/verify-models/SKILL.md says how to tell.`,
      ].join("\n"));
    } else {
      say(`  ${label}: DID NOT RUN`);
      problems.push(`${m.name}: TLC did not finish (exit ${r.code}). Its output is in ${path.relative(ROOT, path.join(dir, `${s.name}.out`))}:\n${r.out.split("\n").filter((l) => l.trim() !== "").slice(-12).map((l) => `    ${l}`).join("\n")}`);
    }
  }

  const mustFail = (run: string, fails: string, head: readonly string[], whenItPasses: string): boolean => {
    const r = of(run);
    if (r.code === VIOLATED && r.violated === fails) {
      const file = save(run, head, r);
      say(`    ${run.replace(/^(replay|open)-/, "").padEnd(22)} fails ${fails} in ${r.trace.length - 1} steps  (${file})`);
      return true;
    }
    say(`    ${run.replace(/^(replay|open)-/, "").padEnd(22)} DID NOT FAIL on ${fails}`);
    problems.push(r.code === 0 ? whenItPasses : `${m.name}: ${run} was to fail on ${fails} and ended otherwise (exit ${r.code}${r.violated === undefined ? "" : `, ${r.violated} broken`}). See ${path.relative(ROOT, path.join(dir, `${run}.out`))}.`);
    return false;
  };
  if (m.replays.length > 0) {
    say("  replays, each a guard switched off, each must fail:");
    const failed = m.replays.filter((r) => mustFail(
      `replay-${r.name}`, r.fails,
      [`Replay ${r.name}${r.past === undefined ? "" : `, the bug fixed in ${r.past}`}: ${r.bug}.`, `Guard switched off: ${r.guard}.`, `Rule it breaks: ${r.fails}.`],
      `${m.name}: the replay ${r.name} PASSED. With its guard off (${r.guard}) the model must break ${r.fails}, and it no longer does, so the model has stopped seeing this bug: ${r.bug}.`,
    )).length;
    say(`  replays failed as required: ${failed} of ${m.replays.length}`);
  }
  if (m.findings.length > 0) {
    say("  rules that hold only while something outside the app behaves, each must still fail without that:");
    for (const f of m.findings) {
      mustFail(
        `open-${f.name}`, f.fails, [`Open finding ${f.name}: ${f.why}.`, `Rule it breaks: ${f.fails}.`],
        `${m.name}: the open finding ${f.name} no longer fails, so ${f.fails} holds without the assumption. Take the entry out of model/models.ts and model/${m.name}/README.md.`,
      );
    }
  }
  return jobs.length;
}

function named(name: string): Model {
  const m = MODELS.find((x) => x.name === name);
  if (m === undefined) throw new Error(`There is no model named ${name}. The models are: ${MODELS.map((x) => x.name).join(", ")}.`);
  return m;
}

async function main(): Promise<void> {
  const started = Date.now();
  const args = process.argv.slice(2);
  const picked: Model[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--confirm") { const m = named(args[++i] ?? ""); confirm(m); picked.push(m); }
    else picked.push(named(args[i]!));
  }
  const models = picked.length === 0 ? MODELS : [...new Set(picked)];
  const java = findJava();
  const jar = findJar();
  const width = Math.max(1, Math.floor(os.availableParallelism() / 2));
  let runs = 0;
  for (const m of models) runs += await check(m, java, jar, width);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  say();
  if (problems.length === 0) { say(`model-check: ${models.length} models, ${runs} runs, all as required, ${seconds} s`); return; }
  say(`model-check: FAILED, ${problems.length} ${problems.length === 1 ? "problem" : "problems"}, ${seconds} s`);
  for (const p of problems) say(`\n${p}`);
  process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(`model-check: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
