// The bug finder: walks the screens a change touched, slowed, keeping every
// frame, and reports what moves, flickers, arrives late, says a thing twice or
// is cut off. Writes finder-report/index.html (one card per finding) and
// finder-report/findings.json. Not part of `pnpm verify` or the release check.
//
//   node scripts/bug-finder.ts --range main..HEAD   screens the range's changed files pick
//   node scripts/bug-finder.ts --all                every screen
//   node scripts/bug-finder.ts --screens queue,chat these screens
//   node scripts/bug-finder.ts --range a..b --list  print the screen ids, walk nothing
//   node scripts/bug-finder.ts --sheet              redraw the sheet from the last walk
//   --keep                                          keep every step's frames, for tuning
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { screensFor } from "../test/finder/match.ts";
import { FINDER_OUT, ROOT } from "../test/finder/out.ts";
import { SCREENS } from "../test/finder/screens.ts";
import { type Sheet, type SheetScreen, renderSheet, unique } from "../test/finder/sheet.ts";
import type { ScreenReport } from "../test/finder/walk.spec.ts";

const USAGE = "usage: node scripts/bug-finder.ts (--range a..b | --all | --screens id,id) [--list] [--sheet] [--spec test/finder/walk.spec.ts]";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} needs a value\n${USAGE}`);
  return v;
}
const has = (name: string) => process.argv.includes(name);

function pick(): { ids: string[]; why: string } {
  const range = arg("--range");
  const named = arg("--screens");
  if (has("--all")) return { ids: SCREENS.map((s) => s.id), why: "all screens" };
  if (named) return { ids: named.split(",").map((s) => s.trim()).filter(Boolean), why: `screens ${named}` };
  if (range) {
    const changed = execFileSync("git", ["diff", "--name-only", range], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
    const { screens, unmatched } = screensFor(changed, SCREENS);
    if (unmatched.length > 0) console.error(`no screen for: ${unmatched.join(", ")}`);
    return { ids: [...screens], why: `${range}: ${changed.length} files changed` };
  }
  throw new Error(USAGE);
}

/** The last walk's raw screens, in table order. */
function readRaw(): ScreenReport[] {
  const dir = path.join(FINDER_OUT, "raw");
  if (!existsSync(dir)) return [];
  const order = new Map(SCREENS.map((s, i) => [s.id, i]));
  return readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as ScreenReport)
    .toSorted((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
}

function writeSheet(title: string, seconds: number): number {
  const screens: SheetScreen[] = readRaw();
  const sheet: Sheet = { title, made: new Date().toISOString().slice(0, 16).replace("T", " "), seconds, screens };
  const found = unique(screens);
  mkdirSync(FINDER_OUT, { recursive: true });
  writeFileSync(path.join(FINDER_OUT, "index.html"), renderSheet(sheet));
  writeFileSync(path.join(FINDER_OUT, "findings.json"), `${JSON.stringify({
    title, seconds,
    screens: screens.map((s) => ({ id: s.id, seconds: s.seconds, steps: s.steps.map((st) => ({ name: st.name, ms: st.ms, frames: st.frames, findings: st.findings.length, ...(st.broken ? { broken: st.broken } : {}) })) })),
    findings: found,
  }, null, 2)}\n`);
  return found.length;
}

function main(): void {
  const spec = arg("--spec") ?? "test/finder/walk.spec.ts";
  if (has("--sheet")) {
    const n = writeSheet("Bug finder", 0);
    console.log(`${n} findings: ${path.join(FINDER_OUT, "index.html")}`);
    return;
  }
  const { ids, why } = pick();
  const bad = ids.filter((id) => !SCREENS.some((s) => s.id === id));
  if (bad.length > 0) throw new Error(`no screen named ${bad.join(", ")}; screens: ${SCREENS.map((s) => s.id).join(", ")}`);
  if (has("--list")) { console.log(ids.join(",")); return; }
  if (ids.length === 0) { console.log(`${why}: no screen to walk`); return; }
  // the last walk's output moves aside, so this sheet shows this walk only
  if (existsSync(FINDER_OUT)) {
    const old = `${FINDER_OUT}-${Date.now()}`;
    renameSync(FINDER_OUT, old);
    console.log(`last report moved to ${path.basename(old)}`);
  }
  mkdirSync(FINDER_OUT, { recursive: true });
  console.log(`walking ${ids.join(", ")} (${why})`);
  const started = Date.now();
  const run = spawnSync("pnpm", ["exec", "playwright", "test", "-c", "test/finder/playwright.config.ts", spec], {
    cwd: ROOT, stdio: "inherit", env: { ...process.env, GL_FINDER_SCREENS: ids.join(","), ...(has("--keep") ? { GL_FINDER_KEEP: "1" } : {}) },
  });
  const seconds = Math.round((Date.now() - started) / 1000);
  const n = writeSheet(`Bug finder: ${why}`, seconds);
  console.log(`FINDER DONE ${n} findings in ${seconds} s: ${path.join(FINDER_OUT, "index.html")}`);
  process.exitCode = run.status ?? 1;
}

try { main(); } catch (e) { console.error(e instanceof Error ? e.message : e); process.exitCode = 2; }
