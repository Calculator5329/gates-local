// One final runner request for focused UI and real isolated transactions.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

assert.ok(process.env.DISPLAY, "Use the approved virtual-screen runner");
async function run(command, args, extraEnv = {}) {
  const child = spawn(command, args, { env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += String(chunk); process.stdout.write(chunk); });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  return { code, output };
}
// The runner fetches its redirected GL_E2E_RESULTS directory for --out test-results.
const output = process.env.GL_E2E_RESULTS ?? path.resolve("test-results/update-ui");
const green = await run("pnpm", ["e2e", "updates.spec.ts", `--output=${output}`, "--trace=on"]);
const runtime = await run(process.execPath, ["test/runtime/auto-update.mjs"]);
console.log(JSON.stringify({ browserExit: green.code, transactionExit: runtime.code }));
process.exitCode = green.code === 0 && runtime.code === 0 ? 0 : 1;
