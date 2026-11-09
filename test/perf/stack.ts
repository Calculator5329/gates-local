// The existing fake and real Node server, with a larger test-only data set.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { CONTROL_PORT, FAKE_PORT, FAKE_URL, ROOT, SERVER_PORT, TOKEN, WEB_ORIGIN } from "../e2e/env.ts";
import { restoreFixture } from "./fixture.ts";
import { prepareLibraryFixture } from "../e2e/library-fixture.ts";

const target = process.env["GL_PERF_TARGET"] ?? ROOT;
const cache = path.join(homedir(), ".cache", "gates-local-perf");
mkdirSync(cache, { recursive: true });
const run = mkdtempSync(path.join(cache, "run-"));
const gpu = path.join(run, "gpu.json");
const data = path.join(run, "data");
const prepared = process.env["GL_PERF_FIXTURE"];
if (!prepared) throw new Error("The performance fixture must be prepared before server startup");
const { short, long, thousands, huge } = restoreFixture(prepared, data);
// Prepare with the shared harness, not a target's potentially older fixture API.
const libraryFixture = prepareLibraryFixture(run);

const children: ChildProcess[] = [];
async function start(args: string[], env: NodeJS.ProcessEnv, ready: RegExp): Promise<ChildProcess> {
  const child = spawn(process.execPath, args, { cwd: target, env, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  await new Promise<void>((resolve, reject) => {
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); if (ready.test(output)) resolve(); });
    child.once("exit", code => reject(new Error(`Fixture exited before ready (${String(code)})`)));
  });
  return child;
}
await start(["test/fake-ollama/main.ts", "--port", String(FAKE_PORT), "--gpu-state", gpu], process.env, /fake ollama on/);
await start(["test/e2e/library-server.ts", "--port", String(SERVER_PORT), "--data-dir", data], {
  ...process.env,
  GATES_LOCAL_OLLAMA_URL: FAKE_URL,
  GATES_LOCAL_NVIDIA_SMI: path.join(target, "test/fake-ollama/nvidia-smi.ts"),
  GATES_LOCAL_FAKE_GPU_STATE: gpu,
  GATES_LOCAL_MEMINFO: path.join(target, "test/fake-ollama/meminfo.txt"),
  GATES_LOCAL_SERVER_TOKEN: TOKEN,
  GATES_LOCAL_ALLOWED_ORIGINS: WEB_ORIGIN,
  GATES_LOCAL_RUNTIME: "discover-only",
  GATES_LOCAL_OLLAMA_BINARY: "none",
  GATES_LOCAL_UPDATE_TEST_ROOT: run,
  GL_E2E_LIBRARY_FIXTURE: libraryFixture,
  XDG_DATA_HOME: path.join(run, "xdg"),
}, /"ready":true/);
const control = createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200).end("ok"); return; }
  if (req.url === "/seed") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ short, long, thousands, huge })); return; }
  res.writeHead(404).end();
});
control.listen(CONTROL_PORT, new URL(FAKE_URL).hostname);
function stop() {
  control.close();
  for (const child of children) child.kill("SIGTERM");
  void Promise.all(children.map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", () => resolve());
  }))).then(() => process.exit(0));
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
