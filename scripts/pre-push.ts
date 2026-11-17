// The checks a push runs before it leaves this machine: typecheck, lint and the client build, all
// at once. Unit and browser tests stay with the landing and release checks; a push that took longer
// than its budget fails and says the budget and what each check took, so a slow check is seen the
// day it gets slow.
//
//   git config core.hooksPath .githooks     (once per clone; .githooks/pre-push runs this file)
//   node scripts/pre-push.ts                 (the same checks by hand)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const BUDGET_MS = 9_000;
export interface Check { name: string; argv: string[] }
export const CHECKS: Check[] = [
  { name: "typecheck", argv: ["pnpm", "typecheck"] },
  { name: "lint", argv: ["pnpm", "lint"] },
  { name: "build", argv: ["pnpm", "build"] },
];
export interface Outcome { name: string; code: number; ms: number; output: string }

function run(check: Check, cwd: string): Promise<Outcome> {
  const start = performance.now();
  return new Promise((resolve) => {
    const child = spawn(check.argv[0]!, check.argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.once("error", (error) => resolve({ name: check.name, code: 127, ms: performance.now() - start, output: error.message }));
    child.once("close", (code) => resolve({ name: check.name, code: code ?? 1, ms: performance.now() - start, output }));
  });
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Runs every check at once. Fails on a failed check, and on a total past the budget. */
export async function runChecks(checks: Check[], cwd: string, budgetMs = BUDGET_MS): Promise<{ code: number; lines: string[] }> {
  const start = performance.now();
  const outcomes = await Promise.all(checks.map((check) => run(check, cwd)));
  const total = performance.now() - start;
  const lines: string[] = [];
  for (const failed of outcomes.filter((o) => o.code !== 0)) lines.push(`pre-push: ${failed.name} failed (exit ${failed.code})`, failed.output.trimEnd());
  const each = outcomes.map((o) => `${o.name} ${seconds(o.ms)}`).join(", ");
  const over = total > budgetMs;
  lines.push(`pre-push: ${seconds(total)} of a ${seconds(budgetMs)} budget (${each})${over ? ": over budget, find what got slow" : ""}`);
  return { code: outcomes.some((o) => o.code !== 0) || over ? 1 : 0, lines };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = await runChecks(CHECKS, root);
  for (const line of result.lines) console.log(line);
  process.exitCode = result.code;
}
