// pnpm measure:compare: run Measure on one model straight against a running Ollama, without the app,
// so the app's harness can be set beside a shell-only one. It writes the measure, every check with
// its grade and reason, as JSON.
//
//   node scripts/measure-compare.ts <model> [--variant default|shell-only] [--base <ollama url>]
//     [--ctx 16384] [--think on|off] [--out <file.json>]
//
// Linux only: the database checks and the shell-only harness run sqlite3 in the shell's sandbox.
// The pages need the app's window, so they are skipped here; they do not change with the harness.
// No picture is made: Measure's image tool records each prompt and returns at once.
// The fixtures and the JSON go under ~/.cache/gates-local-measure-compare unless --out says where.
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeSandbox } from "@gates-local/harness/sandbox";
import { createShellStatus } from "../apps/server/src/chat/shell.ts";
import { ensureFixtures } from "../apps/server/src/measure/cases.ts";
import { skipPages } from "../apps/server/src/measure/score.ts";
import { RUN_BUDGET, VARIANTS, measureModel, type HarnessVariant } from "../apps/server/src/measure/suite.ts";

const PAGES_HEADLESS = "The headless compare has no window to run pages in.";

function usage(why: string): never {
  console.error(`${why}\nusage: node scripts/measure-compare.ts <model> [--variant ${VARIANTS.join("|")}] [--base <ollama url>] [--ctx <tokens>] [--think on|off] [--out <file.json>]`);
  process.exit(2);
}

const isVariant = (v: string | undefined): v is HarnessVariant => VARIANTS.some((x) => x === v);

const args = process.argv.slice(2);
let model: string | undefined;
let variant: HarnessVariant = "default";
let base = "http://127.0.0.1:11434";
let numCtx = 16384;
let think: boolean | undefined;
let out: string | undefined;
for (let i = 0; i < args.length; i += 1) {
  const a = args[i]!;
  const value = () => args[++i] ?? usage(`${a} needs a value`);
  if (a === "--variant") {
    const v = value();
    if (!isVariant(v)) usage(`unknown variant ${v}`);
    variant = v;
  } else if (a === "--base") base = value();
  else if (a === "--ctx") {
    numCtx = Number(value());
    if (!Number.isInteger(numCtx) || numCtx < 2048) usage("--ctx must be a whole number of tokens, at least 2048");
  } else if (a === "--think") {
    const v = value();
    if (v !== "on" && v !== "off") usage("--think is on or off");
    think = v === "on";
  } else if (a === "--out") out = value();
  else if (a.startsWith("--")) usage(`unknown option ${a}`);
  else if (model === undefined) model = a;
  else usage(`one model at a time (got ${model} and ${a})`);
}
if (model === undefined) usage("name the model to measure");
if (process.platform !== "linux") usage("measure:compare runs on Linux only: its database checks need the shell's sandbox");

const home = path.join(os.homedir(), ".cache", "gates-local-measure-compare");
const shell = await createShellStatus(probeSandbox, (line) => console.error(line))();
const started = Date.now();
console.error(`${model} · ${variant} harness · ${numCtx} context · at most ${RUN_BUDGET} answer tokens`);
const result = await measureModel({
  baseUrl: base, model, variant, numCtx, shell, platform: "linux",
  sources: ensureFixtures(path.join(home, "data")),
  signal: AbortSignal.timeout(60 * 60_000),
  ...(think === undefined ? {} : { think }),
  onStep: (done, total, tps) => process.stderr.write(`\r${done} of ${total}${tps > 0 ? `, ${tps} tok/s` : ""}   `),
});
process.stderr.write("\n");
const measure = skipPages({ model, digest: "", ...result }, PAGES_HEADLESS);
const ms = Date.now() - started;

const file = out ?? path.join(home, `${model.replace(/[^\w.-]+/g, "_")}-${variant}-${started}.json`);
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, `${JSON.stringify({ model, variant, base, numCtx, ms, measure }, null, 2)}\n`);
for (const c of measure.checks) console.log(`${c.state === "skipped" ? "skip" : c.ok ? "pass" : "FAIL"}  ${c.id}${c.why ? `  ${c.why}` : ""}`);
console.log(`${model} (${variant}): score ${measure.score}, ${measure.tokensPerSecond} tok/s, ${Math.round(ms / 1000)} s\n${file}`);
