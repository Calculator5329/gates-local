// Explicit, isolated Linux setup. Run only on an authorized CPU smoke runner.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { installPinned } from "../../apps/server/src/runtime/install.ts";
import { PINNED_OLLAMA } from "../../apps/server/src/runtime/manifest.ts";

const MODEL = "smollm2:135m";
const cache = path.join(homedir(), ".cache", "gates-local-real-smoke");
const url = "http://127.0.0.1:16195";

async function exited(child: ChildProcess): Promise<number> {
  if (child.exitCode !== null) return child.exitCode;
  if (child.signalCode !== null) throw new Error(`child ended with ${child.signalCode}`);
  const [code, signal] = await once(child, "exit");
  if (code === null) throw new Error(`child ended with ${String(signal)}`);
  return Number(code);
}

async function main(): Promise<number> {
  if (process.env["GATES_REAL_SMOKE"] !== "1") throw new Error("Set GATES_REAL_SMOKE=1 explicitly on the authorized smoke runner.");
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("The isolated smoke setup requires Linux x64.");
  const resultDir = process.env["GL_E2E_RESULTS"] ?? path.join(cache, "results");
  await mkdir(resultDir, { recursive: true });
  const start = Date.now();
  const installed = await installPinned({ appDataDir: cache, manifest: PINNED_OLLAMA, onProgress: (p) => {
    if (p.phase !== "download") console.log(`[real-smoke setup] ${p.phase}`);
  } });
  console.log(`[real-smoke setup] binary ${installed.alreadyInstalled ? "cached" : "installed"}, ${Date.now() - start} ms`);
  const env = { ...process.env, OLLAMA_HOST: url, OLLAMA_MODELS: path.join(cache, "models"), OLLAMA_NO_CLOUD: "1", OLLAMA_NUM_PARALLEL: "1", OLLAMA_MAX_LOADED_MODELS: "1" };
  const log = createWriteStream(path.join(resultDir, "real-ollama.log"));
  const ollama = spawn(installed.binary, ["serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let listening = false;
  let startupLog = "";
  let launchError: Error | undefined;
  ollama.once("error", (error) => { launchError = error; });
  ollama.stderr.on("data", (chunk: Buffer) => {
    startupLog = (startupLog + chunk.toString()).slice(-4096);
    if (startupLog.includes("Listening on 127.0.0.1:16195")) listening = true;
  });
  ollama.stdout.pipe(log, { end: false });
  ollama.stderr.pipe(log, { end: false });
  try {
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (launchError) throw launchError;
      if (ollama.exitCode !== null || ollama.signalCode !== null) throw new Error("Isolated Ollama exited before readiness; see real-ollama.log (port must be unused).");
      try {
        if (listening) {
          const response = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(1000) });
          if (response.ok) break;
        }
      } catch { /* Startup readiness, bounded below. */ }
      if (Date.now() >= deadline) throw new Error("Isolated Ollama did not become ready in 20 seconds; see real-ollama.log.");
      await delay(100);
    }
    // Never pull the fault-injection model: a missing requested model must fail.
    const pullStart = Date.now();
    const tags = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const listed: unknown = await tags.json();
    const cached = tags.ok && typeof listed === "object" && listed !== null && "models" in listed && Array.isArray(listed.models) && listed.models.some((m: unknown) => typeof m === "object" && m !== null && "name" in m && m.name === MODEL);
    if (!cached) {
      const pull = await fetch(`${url}/api/pull`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: MODEL, stream: false }), signal: AbortSignal.timeout(180_000) });
      const pulled: unknown = await pull.json();
      if (!pull.ok || typeof pulled !== "object" || pulled === null || !("status" in pulled) || pulled.status !== "success") throw new Error(`Real model pull failed: HTTP ${pull.status}, ${JSON.stringify(pulled)}`);
    }
    console.log(`[real-smoke setup] model ${MODEL} ${cached ? "cached" : "downloaded"}, ${Date.now() - pullStart} ms`);
    const test = spawn("pnpm", ["e2e", "real-smoke.spec.ts", "--trace=on"], { env: { ...process.env, GATES_REAL_SMOKE_URL: url }, stdio: "inherit" });
    return await exited(test);
  } finally {
    if (ollama.exitCode === null && ollama.signalCode === null) {
      const stopped = once(ollama, "exit");
      ollama.kill("SIGTERM");
      const kill = setTimeout(() => ollama.kill("SIGKILL"), 3000);
      await stopped;
      clearTimeout(kill);
    }
    log.end();
    console.log("[real-smoke setup] owned Ollama stopped; runner receipt must also show zero remaining descendants");
  }
}

main().then((code) => { process.exitCode = code; }, (error: unknown) => { console.error(error); process.exitCode = 1; });
