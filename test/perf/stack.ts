// The existing fake and real Node server, with a larger test-only data set.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CONTROL_PORT, FAKE_PORT, FAKE_URL, ROOT, SERVER_PORT, TOKEN, WEB_ORIGIN } from "../e2e/env.ts";
import type { defaultSettings } from "../../apps/server/src/settings/store.ts";
import type { openThreadStore } from "../../apps/server/src/threads/store.ts";

const target = process.env["GL_PERF_TARGET"] ?? ROOT;
const cache = path.join(homedir(), ".cache", "gates-local-perf");
mkdirSync(cache, { recursive: true });
const run = mkdtempSync(path.join(cache, "run-"));
const gpu = path.join(run, "gpu.json");
const data = path.join(run, "data");
mkdirSync(data);
const db = path.join(data, "threads.sqlite");
// Same SQLite schema as the subject. A schema change must update the fixture explicitly.
const subject = await import(pathToFileURL(path.join(target, "apps/server/src/threads/store.ts")).href) as { openThreadStore: typeof openThreadStore };
const store = subject.openThreadStore(db);
function seedLong(messages: number) {
  const id = store.createThread({ title: `Perf ${messages === 200 ? "long" : "thousands"} ${messages}` }).id;
  for (let i = 0; i < messages; i++) store.appendMessage({ threadId: id, role: i % 2 ? "assistant" : "user", content: i % 2 ? "A measured answer.\n\n- First item\n- Second item\n\n```ts\nconst value = 42;\n```" : `Question ${i}`, ...(i % 2 ? { model: "qwen3.5:9b" } : {}) });
  return id;
}
const long = seedLong(200);
const thousands = seedLong(2000);
const short = store.createThread({ title: "Perf short" }).id;
store.appendMessage({ threadId: short, role: "user", content: "Short marker" });
const huge = store.createThread({ title: "Perf huge reply" }).id;
const hugeText = ["Huge reply marker", "", "```ts", ...Array.from({ length: 4000 }, (_, i) => `const item${i} = { value: ${i}, label: 'deterministic code fixture' };`), "```", "", "| Item | Value |", "| --- | --- |", ...Array.from({ length: 300 }, (_, i) => `| Row ${i} | Value ${i} |`), "", "Huge reply end"].join("\n");
store.appendMessage({ threadId: huge, role: "assistant", content: hugeText, model: "qwen3.5:9b" });
for (let i = 0; i < 396; i++) store.createThread({ title: `Perf sidebar ${String(i).padStart(3, "0")}` });
store.close();
const settings = await import(pathToFileURL(path.join(target, "apps/server/src/settings/store.ts")).href) as { defaultSettings: typeof defaultSettings; SETTINGS_FILE_NAME: string; SETTINGS_FILE_VERSION: number };
writeFileSync(path.join(data, settings.SETTINGS_FILE_NAME), JSON.stringify({ version: settings.SETTINGS_FILE_VERSION, settings: { ...settings.defaultSettings("system"), thinking: false } }));

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
