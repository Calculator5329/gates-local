// The finder's scoreboard: each case is a bug the owner reported that the tests
// missed (test/finder/cases/<id>/). For each one the board makes a scratch
// worktree of HEAD, undoes the fix with the case's undo (test/finder/undo.ts), walks the case's
// screens, and asks whether the finder said something new there that clean HEAD
// does not say. Clean HEAD is walked whole, and its findings are sorted against
// test/finder/known.json into real, not real and not looked at yet.
//
//   node scripts/finder-board.ts                    every case, local walks
//   node scripts/finder-board.ts --cases a,b        these cases (clean is still walked whole)
//   --jobs 4                                        walks at once
//   --keep                                          keep the scratch worktrees
//   --check                                         walk nothing: say which cases' undos no longer
//                                                   apply to this checkout, exit 1 if any
//   GL_FINDER_RUNNER='bash <pool>/e2e.sh --finder {worktree} --screens {screens}'
//                                                   walk through another runner; {worktree}
//                                                   and {screens} are filled in, and the walk
//                                                   leaves <worktree>/finder-report/findings.json
//   GL_FINDER_BOARD_DIR=<dir>                       where the scratch worktrees go (default:
//                                                   <checkout>-board/<time>, beside the checkout)
//
// Prints a table and two numbers: caught N of M, and clean findings that are not
// real. Writes finder-board/board.md, board.json and each walk's report. Exits 1
// when a walk broke or a case could not be played: a board with a hole in it is
// not a score.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Case, type Known, parseCase, score, triage } from "../test/finder/known.ts";
import { ROOT } from "../test/finder/out.ts";
import { SCREENS } from "../test/finder/screens.ts";
import { undo } from "../test/finder/undo.ts";
import { type Found, headline } from "../test/finder/sheet.ts";

const USAGE = "usage: node scripts/finder-board.ts [--cases id,id] [--jobs N] [--keep] [--check]";
const CASES = path.join(ROOT, "test/finder/cases");
const OUT = path.join(ROOT, "finder-board");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} needs a value\n${USAGE}`);
  return v;
}
const has = (name: string) => process.argv.includes(name);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function readCases(only: readonly string[] | undefined): Case[] {
  const ids = readdirSync(CASES).filter((d) => existsSync(path.join(CASES, d, "case.json"))).toSorted();
  const missing = (only ?? []).filter((id) => !ids.includes(id));
  if (missing.length > 0) throw new Error(`no case named ${missing.join(", ")}; cases: ${ids.join(", ")}`);
  const cases = ids.filter((id) => !only || only.includes(id)).map((id) => parseCase(id, JSON.parse(readFileSync(path.join(CASES, id, "case.json"), "utf8"))));
  const screens = new Set(SCREENS.map((s) => s.id));
  for (const c of cases) {
    const bad = [...c.screens, ...c.catch.map((e) => e.screen)].filter((s) => !screens.has(s));
    if (bad.length > 0) throw new Error(`case ${c.id}: no screen named ${bad.join(", ")}`);
  }
  return cases;
}

interface Walk {
  readonly id: string;
  readonly worktree: string;
  readonly screens: string;
  /** The case's folder, for a walk with a fix undone. */
  readonly undo?: string;
}
interface Walked extends Walk {
  readonly findings?: readonly Found[];
  readonly broken?: string;
  readonly seconds: number;
}

/** The runner's command for one walk: the template split on spaces, then filled in. */
export function command(template: string, w: { worktree: string; screens: string }): string[] {
  return template.trim().split(/\s+/).map((part) => part.replaceAll("{worktree}", w.worktree).replaceAll("{screens}", w.screens));
}

function run(w: Walk, template: string, logs: string): Promise<Walked> {
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 1000);
  const cannot = w.undo === undefined ? undefined : undo(w.worktree, w.undo, true);
  if (cannot !== undefined) return Promise.resolve({ ...w, seconds: 0, broken: cannot });
  const [cmd, ...args] = command(template, w);
  const log = createWriteStream(path.join(logs, `${w.id}.log`));
  return new Promise((resolve) => {
    const child = spawn(cmd!, args, { cwd: w.worktree, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on("error", (e) => { log.end(); resolve({ ...w, seconds: seconds(), broken: `runner did not start: ${e.message}` }); });
    child.on("close", (status) => {
      log.end();
      const file = path.join(w.worktree, "finder-report", "findings.json");
      if (!existsSync(file)) { resolve({ ...w, seconds: seconds(), broken: `no findings.json (runner exit ${status}); see ${w.id}.log` }); return; }
      const report = JSON.parse(readFileSync(file, "utf8")) as { findings: Found[]; screens: { steps: { broken?: string }[] }[] };
      const broke = report.screens.flatMap((s) => s.steps).find((s) => s.broken)?.broken;
      resolve({ ...w, seconds: seconds(), findings: report.findings, ...(broke ? { broken: `a step broke: ${broke}` } : {}) });
    });
  });
}

/** Runs the walks, `jobs` at a time, in order of the list. */
async function pool<T, R>(items: readonly T[], jobs: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); }
  }));
  return out;
}

const cell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");
/** The finding's pictures, under the board's copy of the walk. */
const shot = (id: string, f: Found) => f.pics.filter((p) => p !== null).map((p) => `${id}/${p}`).join(" → ") || "none";
const where = (f: Found) => `${f.screen} › ${f.step}`;

async function main(): Promise<void> {
  const only = arg("--cases")?.split(",").map((s) => s.trim()).filter(Boolean);
  const jobs = Number(arg("--jobs") ?? 4);
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`--jobs needs a whole number\n${USAGE}`);
  const template = process.env["GL_FINDER_RUNNER"] ?? "node scripts/bug-finder.ts --screens {screens}";
  const cases = readCases(only);
  if (has("--check")) {
    const broken = cases.map((c) => ({ id: c.id, why: undo(ROOT, path.join(CASES, c.id), false) })).filter((c) => c.why !== undefined);
    for (const c of broken) console.log(`${c.id}: ${c.why}`);
    console.log(`CASES ${cases.length - broken.length} of ${cases.length} can be played`);
    if (broken.length > 0) process.exitCode = 1;
    return;
  }
  const known = JSON.parse(readFileSync(path.join(ROOT, "test/finder/known.json"), "utf8")) as Known[];

  const head = git(ROOT, "rev-parse", "--short", "HEAD");
  const dirty = git(ROOT, "status", "--porcelain", "--", "test/finder", "scripts");
  if (dirty) console.error(`the board walks HEAD ${head}; these changes are not in it:\n${dirty}`);
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "").replace("T", "-");
  const dir = path.resolve(process.env["GL_FINDER_BOARD_DIR"] ?? path.join(path.dirname(ROOT), `${path.basename(ROOT)}-board`), stamp);
  const out = path.join(OUT, stamp);
  mkdirSync(dir, { recursive: true });
  mkdirSync(out, { recursive: true });

  const walks: Walk[] = [
    { id: "clean", worktree: path.join(dir, "clean"), screens: SCREENS.map((s) => s.id).join(",") },
    ...cases.map((c) => ({ id: c.id, worktree: path.join(dir, c.id), screens: c.screens.join(","), undo: path.join(CASES, c.id) })),
  ];
  for (const w of walks) git(ROOT, "worktree", "add", "--quiet", "--detach", w.worktree, "HEAD");
  console.log(`board: HEAD ${head}, ${cases.length} cases and clean, ${jobs} at a time, runner: ${template}`);
  const started = Date.now();
  const walked = await pool(walks, jobs, async (w) => {
    const r = await run(w, template, out);
    console.log(`  ${w.id}: ${r.broken ?? `${r.findings?.length ?? 0} findings`} (${r.seconds} s)`);
    const report = path.join(w.worktree, "finder-report");
    if (existsSync(report)) cpSync(report, path.join(out, w.id), { recursive: true });
    return r;
  });

  const clean = walked[0]!;
  const sorted = triage(clean.findings ?? [], known);
  const rows = cases.map((c, i) => {
    const w = walked[i + 1]!;
    const hit = w.findings ? score(c, w.findings, clean.findings ?? []) : undefined;
    return { case: c, walked: w, hit };
  });
  const caught = rows.filter((r) => r.hit).length;

  const table = [
    "| case | owner said | screens | result | detector for a miss |",
    "|---|---|---|---|---|",
    ...rows.map(({ case: c, walked: w, hit }) => `| ${c.id} | ${cell(c.owner.slice(0, 80))} | ${c.screens.join(", ")} | ${
      hit ? `caught: ${cell(headline(hit))} (${cell(where(hit))}), shot ${shot(w.id, hit)}` : w.broken ? `broken: ${cell(w.broken)}` : `missed (${w.findings?.length ?? 0} findings, none new where expected)`
    } | ${hit ? "" : cell(c.detector ?? "the expected detector fired nowhere new: tune it")} |`),
  ].join("\n");
  const cleanLines = [
    ...sorted.real.map((f) => `- real: ${where(f)}: ${headline(f)} (shot ${shot("clean", f)})`),
    ...sorted.notReal.map((f) => `- not real: ${where(f)}: ${headline(f)}`),
    ...sorted.fresh.map((f) => `- not looked at: ${where(f)}: ${headline(f)} (shot ${shot("clean", f)})`),
  ];
  const totals = `caught ${caught} of ${cases.length}\nclean findings not real: ${sorted.notReal.length}${sorted.fresh.length > 0 ? ` (and ${sorted.fresh.length} not looked at yet)` : ""}; real: ${sorted.real.length}${clean.broken ? `\nclean walk: ${clean.broken}` : ""}`;
  const seconds = Math.round((Date.now() - started) / 1000);
  const md = `# Finder board, HEAD ${head}, ${stamp}\n\n${totals}\n\n${table}\n\n## Clean HEAD\n\n${cleanLines.join("\n") || "- nothing"}\n\n${seconds} s\n`;
  writeFileSync(path.join(out, "board.md"), md);
  writeFileSync(path.join(out, "board.json"), `${JSON.stringify({
    head, stamp, seconds, caught, cases: cases.length,
    clean: { real: sorted.real, notReal: sorted.notReal, fresh: sorted.fresh, broken: clean.broken },
    rows: rows.map(({ case: c, walked: w, hit }) => ({ id: c.id, caught: hit !== undefined, hit, broken: w.broken, findings: w.findings?.length, detector: hit ? undefined : c.detector })),
  }, null, 2)}\n`);

  if (!has("--keep")) {
    // the undo is put back first so git removes the worktree without --force
    for (const w of walks) {
      try { git(w.worktree, "checkout", "--", "."); git(ROOT, "worktree", "remove", w.worktree); } catch { console.error(`left in place: ${w.worktree}`); }
    }
  }
  console.log(`\n${table}\n\n${cleanLines.join("\n")}\n\nBOARD DONE in ${seconds} s: ${path.join(out, "board.md")}\n${totals}`);
  if (walked.some((w) => w.broken !== undefined)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 2; });
}
