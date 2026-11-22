// `pnpm lint`: oxlint's own checks, and the project's rules against their recorded counts.
// `pnpm lint:baseline` (--write): re-record those counts after files move or offenders go.
import { spawn } from "node:child_process";
import path from "node:path";
import { check, configuredRules, findings, OXLINT, readBaseline, rewrite } from "./ratchet.ts";

const ROOT = path.join(import.meta.dirname, "..");
const PATHS = ["apps", "packages", "scripts", "test", "lint", "model"];

const write = process.argv.includes("--write");

// The stock pass prints its own findings and runs while the project rules are counted.
const stock = write ? Promise.resolve(0) : new Promise<number | null>((resolve) => {
  spawn(process.execPath, [OXLINT, "--deny-warnings", ...PATHS], { cwd: ROOT, stdio: "inherit" })
    .on("error", () => resolve(null))
    .on("close", resolve);
});

const rules = configuredRules();
const found = findings(ROOT, PATHS);
const result = write ? rewrite(readBaseline(), found, rules) : check(readBaseline(), found, rules);

const stockExit = await stock;
(result.ok ? console.log : console.error)(result.lines.join("\n"));
process.exitCode = stockExit === 0 && result.ok ? 0 : 1;
