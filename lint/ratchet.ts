import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** rule -> file -> how many times the rule fires there. Every configured rule has a key, even at zero. */
export type Counts = Record<string, Record<string, number>>;
export type Finding = { rule: string; file: string; line: number; message: string };
export type Change = { rule: string; file: string; was: number; now: number };

const LINT_DIR = import.meta.dirname;
export const RULES_CONFIG = path.join(LINT_DIR, "rules.oxlintrc.json");
export const BASELINE = path.join(LINT_DIR, "baseline.json");
export const REWRITE = "pnpm lint:baseline";

/** oxlint's entry script. Run it with this Node (`process.execPath`), so the call works where a shebang script does not. */
export const OXLINT = path.join(path.dirname(createRequire(import.meta.url).resolve("oxlint/package.json")), "bin", "oxlint");

type RuleTable = { rules?: Record<string, unknown> };

/** Every rule the project config names, in its top-level table or an override. */
export function configuredRules(configFile: string = RULES_CONFIG): string[] {
  const config = JSON.parse(readFileSync(configFile, "utf8")) as RuleTable & { overrides?: RuleTable[] };
  const names = [config, ...config.overrides ?? []].flatMap(table => Object.keys(table.rules ?? {}));
  return [...new Set(names)].toSorted();
}

/**
 * oxlint reports `scope(name)`, and for some plugins the scope is not the
 * one the config uses. A report that matches no configured rule is an
 * error here, never a silently dropped finding.
 */
function configuredName(code: string, rules: string[]): string {
  const match = /^([\w-]+)\(([\w-]+)\)$/.exec(code);
  if (match === null) throw new Error(`oxlint reported a finding with no rule name: ${code}`);
  const exact = `${match[1]}/${match[2]}`;
  if (rules.includes(exact)) return exact;
  const byName = rules.filter(rule => rule.endsWith(`/${match[2]}`));
  if (byName.length === 1 && byName[0] !== undefined) return byName[0];
  throw new Error(`oxlint reported ${code}, which ${path.basename(RULES_CONFIG)} does not name`);
}

type Report = {
  diagnostics: { message: string; code: string; filename: string; labels: { span: { line: number } }[] }[];
  number_of_files: number;
};

/** Lints `paths` under `cwd` with the project rules and returns every finding. Throws when oxlint did not lint. */
export function findings(cwd: string, paths: string[], configFile: string = RULES_CONFIG): Finding[] {
  const rules = configuredRules(configFile);
  const run = spawnSync(process.execPath, [OXLINT, "-c", configFile, "--format", "json", ...paths], {
    cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  let report: Report;
  try { report = JSON.parse(run.stdout) as Report; }
  catch { throw new Error(`oxlint did not finish (exit ${run.status}):\n${run.stderr}${run.stdout}`); }
  if (!Array.isArray(report.diagnostics) || !(report.number_of_files > 0)) {
    throw new Error(`oxlint linted no files under ${paths.join(" ")}`);
  }
  return report.diagnostics.map(found => ({
    rule: configuredName(found.code, rules),
    file: found.filename.split(path.sep).join("/"),
    line: found.labels[0]?.span.line ?? 0,
    message: found.message,
  }));
}

export function count(found: Finding[], rules: string[]): Counts {
  const counts: Counts = Object.fromEntries(rules.map(rule => [rule, {}]));
  for (const { rule, file } of found) {
    const files = counts[rule] ??= {};
    files[file] = (files[file] ?? 0) + 1;
  }
  return sorted(counts);
}

const byKey = <T>(record: Record<string, T>) => Object.entries(record).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);

function sorted(counts: Counts): Counts {
  return Object.fromEntries(byKey(counts).map(([rule, files]) => [rule, Object.fromEntries(byKey(files))]));
}

export const total = (files: Record<string, number> = {}) => Object.values(files).reduce((sum, n) => sum + n, 0);

/** Each rule and file whose count differs from the recorded one, split by direction. */
export function compare(recorded: Counts, now: Counts): { rose: Change[]; fell: Change[]; newRules: string[] } {
  const rose: Change[] = [], fell: Change[] = [];
  const newRules = Object.keys(now).filter(rule => recorded[rule] === undefined);
  for (const rule of new Set([...Object.keys(recorded), ...Object.keys(now)])) {
    if (newRules.includes(rule)) continue;
    const before = recorded[rule] ?? {}, after = now[rule] ?? {};
    for (const file of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const change = { rule, file, was: before[file] ?? 0, now: after[file] ?? 0 };
      if (change.now > change.was) rose.push(change);
      if (change.now < change.was) fell.push(change);
    }
  }
  return { rose, fell, newRules };
}

/** Rules whose count across the whole repo is higher than recorded. Moving or splitting a file never causes this. */
export function risenTotals(recorded: Counts, now: Counts): { rule: string; was: number; now: number }[] {
  return Object.keys(now)
    .filter(rule => recorded[rule] !== undefined)
    .map(rule => ({ rule, was: total(recorded[rule]), now: total(now[rule]) }))
    .filter(change => change.now > change.was);
}

const NOTE = `Generated by \`${REWRITE}\`: how many times each project rule still fires, per file. A count may fall, never rise.`;

export function readBaseline(file: string = BASELINE): Counts {
  if (!existsSync(file)) return {};
  try { return (JSON.parse(readFileSync(file, "utf8")) as { counts: Counts }).counts; }
  catch {
    throw new Error(
      `${path.basename(file)} cannot be read. After a merge conflict in it, take either side whole `
        + `(\`git checkout --ours lint/${path.basename(file)}\`), then run \`${REWRITE}\`.`,
    );
  }
}

export function writeBaseline(counts: Counts, file: string = BASELINE): void {
  writeFileSync(file, `${JSON.stringify({ note: NOTE, counts: sorted(counts) }, null, 2)}\n`);
}

function listed(changes: Change[], found: Finding[]): string[] {
  const lines: string[] = [];
  for (const rule of new Set(changes.map(change => change.rule))) {
    const files = changes.filter(change => change.rule === rule);
    const here = found.filter(finding => finding.rule === rule && files.some(change => change.file === finding.file));
    // A rule whose advice is the same everywhere says it once; one that names the import says it per line.
    const shared = new Set(here.map(finding => finding.message)).size === 1 ? here[0]?.message : undefined;
    lines.push("", shared === undefined ? rule : `${rule}: ${shared}`);
    for (const change of files) {
      const at = here.filter(finding => finding.file === change.file);
      lines.push(`  ${change.file}  ${change.now} now, ${change.was} recorded  (lines ${at.map(finding => finding.line).join(", ")})`);
      if (shared === undefined) lines.push(...at.map(finding => `    ${finding.line}: ${finding.message}`));
    }
  }
  return lines;
}

/** The gate. Returns the lines to print and whether it passed. */
export function check(recorded: Counts, found: Finding[], rules: string[]): { ok: boolean; lines: string[] } {
  const now = count(found, rules);
  const { rose, fell, newRules } = compare(recorded, now);
  const known = Object.values(now).reduce((sum, files) => sum + total(files), 0);
  if (rose.length === 0 && fell.length === 0 && newRules.length === 0) {
    return { ok: true, lines: [`Project rules: ${rules.length} rules, ${known} recorded offenders left, none new.`] };
  }
  const lines: string[] = [];
  if (rose.length > 0) {
    lines.push(
      "Project rules: new offenders. Fix each one the way its message says.",
      `If these are old offenders in files that moved, run \`${REWRITE}\`: it re-records the counts and refuses if any rule's total went up.`,
      ...listed(rose, found),
    );
  }
  if (fell.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `Project rules: ${fell.length} recorded count${fell.length === 1 ? " is" : "s are"} higher than the code now has. Run \`${REWRITE}\` to record the lower counts, and commit lint/baseline.json.`,
      ...fell.map(change => `  ${change.rule}  ${change.file}  ${change.now} now, ${change.was} recorded`),
    );
  }
  if (newRules.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`Project rules: no recorded counts for ${newRules.join(", ")}. Run \`${REWRITE}\` to record where each starts, and commit lint/baseline.json.`);
  }
  return { ok: false, lines };
}

/** Re-records the counts. Refuses, and writes nothing, when a rule's total across the repo went up. */
export function rewrite(recorded: Counts, found: Finding[], rules: string[], file: string = BASELINE): { ok: boolean; lines: string[] } {
  const now = count(found, rules);
  const risen = risenTotals(recorded, now);
  if (risen.length > 0) {
    const { rose } = compare(recorded, now);
    return {
      ok: false,
      lines: [
        "Not recorded: these rules fire more often than before, so this is not only files moving.",
        ...risen.map(change => `  ${change.rule}: ${change.now} now, ${change.was} recorded`),
        "Fix the new ones the way each message says. The files below hold more than was recorded for them.",
        ...listed(rose.filter(change => risen.some(rule => rule.rule === change.rule)), found),
      ],
    };
  }
  writeBaseline(now, file);
  const left = Object.values(now).reduce((sum, files) => sum + total(files), 0);
  return { ok: true, lines: [`Recorded ${left} offenders across ${rules.length} rules in lint/baseline.json.`] };
}
