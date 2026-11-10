// Keeps a table a person can read, one column per release. The file is the
// store: each run adds a column to what is already committed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isChange, type Signal } from "./score-next.ts";

export interface HistoryRow { action: string; unit: "ms" | "count"; kind: "exact" | "sampled"; candidateValue: number; signal: Signal }
const SIGNALS: readonly unknown[] = ["slower", "faster", "within noise", "not scored"] satisfies Signal[];
interface Table { labels: string[]; rows: Map<string, string[]> }

const PREAMBLE = `# Performance history

One column per release, measured on the test machine with the priority journeys.
Times show the lower quartile of the repetitions. A count that was the same in
every run is exact and prints whole; ~ marks a count that varied between runs,
and shows its lower quartile to one decimal. A word beside a number means the
release measured differently from the build it was compared with; "not scored"
means it had too few repetitions to be tested at all. These numbers are
information, not a gate.

Refresh with \`node test/perf/history.ts --label RELEASE --scored RESULTS/scored.json\`.
`;
const TIME_HEADING = "## Time";
const WORK_HEADING = "## Work";
const TIME_ROW = /^[^.]+$|\.cpu-task$/;
const WORK_ROW = /\.(react-commits|react-renders|layouts|requests|bytes|ws-in|dom-elements)$/;

function cell(row: HistoryRow): string {
  const value = row.unit === "count"
    ? row.kind === "exact" ? Math.round(row.candidateValue).toString() : `~${row.candidateValue.toFixed(1)}`
    : row.candidateValue >= 100 ? Math.round(row.candidateValue).toString() : row.candidateValue.toFixed(1);
  return row.signal === "within noise" ? value : `${value} (${row.signal})`;
}

function rowName(row: HistoryRow): string {
  return `${row.action} (${row.unit})`;
}

function columns(line: string): string[] {
  return line.slice(1, -1).split("|").map(part => part.trim());
}

function readTable(lines: readonly string[]): Table {
  const header = lines.find(line => line.startsWith("| Action"));
  if (!header) return { labels: [], rows: new Map() };
  const labels = columns(header).slice(1);
  const rows = new Map(lines.filter(line => line.startsWith("|") && !line.startsWith("| Action") && !line.startsWith("| ---")).map((line): [string, string[]] => {
    const [name, ...cells] = columns(line);
    return [name!, cells];
  }));
  return { labels, rows };
}

function section(text: string, heading: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

function addColumn(table: Table, label: string, rows: readonly HistoryRow[]): Table {
  const known = new Map(rows.map(row => [rowName(row), cell(row)]));
  const names = [...new Set([...table.rows.keys(), ...known.keys()])];
  return {
    labels: [...table.labels, label],
    rows: new Map(names.map(name => [name, [...(table.rows.get(name) ?? table.labels.map(() => "")), known.get(name) ?? ""]])),
  };
}

function writeTable(table: Table): string[] {
  return [
    `| Action | ${table.labels.join(" | ")} |`,
    `| --- | ${table.labels.map(() => "---:").join(" | ")} |`,
    ...[...table.rows].map(([name, cells]) => `| ${name} | ${cells.join(" | ")} |`),
  ];
}

/** The history text with one more release in it. */
export function addRelease(text: string, label: string, rows: readonly HistoryRow[]): string {
  const time = readTable(section(text, TIME_HEADING)), work = readTable(section(text, WORK_HEADING));
  if (time.labels.includes(label) || work.labels.includes(label)) throw new Error(`The history already has ${label}`);
  return [
    PREAMBLE, TIME_HEADING, "", ...writeTable(addColumn(time, label, rows.filter(row => TIME_ROW.test(row.action)))),
    "", WORK_HEADING, "", ...writeTable(addColumn(work, label, rows.filter(row => WORK_ROW.test(row.action)))), "",
  ].join("\n");
}

function isHistoryRow(value: unknown): value is HistoryRow {
  return typeof value === "object" && value !== null
    && "action" in value && typeof value.action === "string"
    && "unit" in value && (value.unit === "ms" || value.unit === "count")
    && "kind" in value && (value.kind === "exact" || value.kind === "sampled")
    && "candidateValue" in value && typeof value.candidateValue === "number"
    && "signal" in value && SIGNALS.includes(value.signal);
}

/** The verdicts, without words when the job compared a build with itself, since any signal there is false. */
export function parseScored(text: string): HistoryRow[] {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || !("verdicts" in value) || !Array.isArray(value.verdicts) || !value.verdicts.every(isHistoryRow)) throw new Error("Not a scored result");
  const commits: unknown = "commits" in value ? value.commits : undefined;
  const self = typeof commits === "object" && commits !== null && "base" in commits && "candidate" in commits && commits.base === commits.candidate;
  return self ? value.verdicts.map(row => isChange(row.signal) ? { ...row, signal: "within noise" as const } : row) : value.verdicts;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { label: { type: "string" }, scored: { type: "string" }, file: { type: "string", default: "docs/perf-history.md" } } });
  if (!values.label || !values.scored) throw new Error("Use --label RELEASE --scored RESULTS/scored.json");
  const current = existsSync(values.file) ? readFileSync(values.file, "utf8") : "";
  writeFileSync(values.file, addRelease(current, values.label, parseScored(readFileSync(values.scored, "utf8"))));
  console.log(`Added ${values.label} to ${values.file}`);
}
