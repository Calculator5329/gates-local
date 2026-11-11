// Checks a local copy of a sample database against the catalog: its sha256, its
// tables and row counts, and each of its five questions' SQL against the answer
// stored in apps/server/src/sources/sample-questions.json. The file is opened
// read-only with extensions off; nothing is downloaded. Not part of `pnpm verify`.
//
//   node scripts/check-sample.ts <sample id> <file>
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SAMPLES } from "../apps/server/src/sources/samples.ts";

interface Question { readonly kind: string; readonly text: string; readonly sql: string; readonly answer: string }
const FIXTURE = JSON.parse(readFileSync(new URL("../apps/server/src/sources/sample-questions.json", import.meta.url), "utf8")) as Record<string, readonly Question[]>;

/** One value as the stored answers print it: integers bare, reals with a decimal point, NULL as None. */
function cell(v: unknown): string {
  if (v === null) return "None";
  if (typeof v === "bigint") return String(v);
  if (typeof v === "number") return Number.isInteger(v) ? `${v}.0` : String(v);
  return String(v);
}

/** Header and rows, " | " between cells, as the stored answers are written. */
function rows(db: DatabaseSync, sql: string): string[] {
  const stmt = db.prepare(sql);
  stmt.setReadBigInts(true); // INTEGER comes back a bigint, REAL a number: 4 and 4.0 stay apart
  const result = stmt.all() as Record<string, unknown>[];
  const cols = stmt.columns().map(c => c.name);
  return [cols.join(" | "), ...result.map(r => cols.map(c => cell(r[c])).join(" | "))];
}

/** An answer written "… (N rows)" holds the first rows only: they and the count must match. */
function matches(got: string[], answer: string): string | null {
  const lines = answer.split("\n");
  const cut = /^\.\.\. \((\d+) rows\)$/.exec(lines.at(-1) ?? "");
  const want = cut ? lines.slice(0, -1) : lines;
  for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) return `line ${i + 1}: expected "${want[i]}", got "${got[i] ?? "(none)"}"`;
  const total = cut ? Number(cut[1]) : want.length - 1;
  if (got.length - 1 !== total) return `expected ${total} rows, got ${got.length - 1}`;
  return null;
}

const [id, file] = process.argv.slice(2);
const sample = SAMPLES.find(s => s.id === id);
if (!sample || !file) {
  console.error(`usage: node scripts/check-sample.ts <${SAMPLES.map(s => s.id).join("|")}> <file>`);
  process.exit(2);
}
let failed = 0;
const report = (ok: boolean, what: string, why = "") => { if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${what}${why ? `: ${why}` : ""}`); };

const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
report(digest === sample.sha256, "sha256", digest === sample.sha256 ? digest : `expected ${sample.sha256}, got ${digest}`);

const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
try {
  const names = (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' ORDER BY name").all() as { name: string }[]).map(r => r.name);
  const want = sample.tables.map(t => t.name);
  const same = names.join(",") === want.toSorted().join(",");
  report(same, `tables (${names.length})`, same ? "" : `expected ${want.join(", ")}; got ${names.join(", ")}`);
  for (const t of sample.tables) {
    const n = names.includes(t.name) ? Number((db.prepare(`SELECT count(*) AS n FROM "${t.name.replaceAll('"', '""')}"`).get() as { n: number }).n) : -1;
    report(n === t.rows, `rows in ${t.name}`, n === t.rows ? String(n) : `expected ${t.rows}, got ${n < 0 ? "no table" : n}`);
  }
  for (const q of FIXTURE[sample.id] ?? []) {
    let why: string | null;
    try { why = matches(rows(db, q.sql), q.answer); } catch (e) { why = e instanceof Error ? e.message : String(e); }
    report(why === null, `${q.kind}: ${q.text}`, why ?? "");
  }
} finally { db.close(); }
console.log(failed === 0 ? `${sample.id}: all checks passed` : `${sample.id}: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
