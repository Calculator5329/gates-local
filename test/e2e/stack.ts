// The E2E backend Playwright starts as one webServer: the fake Ollama and the
// real server (apps/server/src/main.ts) as child processes, plus a small
// control endpoint the specs call between journeys.
//
//   GET  /health            200 once the fake and the server are up
//   POST /reset {scenario?, seed?, seedAt?, runtimeMode?, ...fakeOptions}
//                           set the fake's scenario, then restart the server
//                           on a fresh data dir (rediscovers Ollama). seed: N
//                           writes one thread of N messages, seed: "design" the
//                           design's sidebar, seed: "readme" the README's demo
//                           threads (test/e2e/seed.ts), all pinned to
//                           seedAt; installed: [names] sets the fake's installed
//                           models; runtimeMode ("system" | "app") writes saved
//                           settings in that mode, else first run picks it; the
//                           reply carries the open thread's id
//   POST /restart {downMs?} stop the server, wait, start it on the same data dir
//   POST /scenario {...}    forward to the fake's /__fake/scenario
//
// The server exits on stdin EOF, so each child keeps a stdin pipe open for
// its whole life. Nothing here talks to a real Ollama, GPU or nvidia-smi, and
// the server never looks for an Ollama binary (GATES_LOCAL_OLLAMA_BINARY=none)
// or at this user's app data (XDG_DATA_HOME is the run's own), so the runtime
// states are the same on every machine.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import path from "node:path";
import { CONTROL_PORT, DATA_ROOT, FAKE_PORT, FAKE_URL, ROOT, SERVER_PORT, TOKEN, WEB_ORIGIN } from "./env.ts";
import type { Settings } from "@gates-local/contracts";
import { SETTINGS_FILE_NAME, SETTINGS_FILE_VERSION, defaultSettings } from "../../apps/server/src/settings/store.ts";
import { seedDesign, seedLong, seedReadme } from "./seed.ts";

const runDir = path.join(DATA_ROOT, new Date().toISOString().replaceAll(/[:.]/g, "-"));
const gpuState = path.join(runDir, "gpu-state.json");
mkdirSync(runDir, { recursive: true });
let resets = 0;
let dataDir = "";

const log = (line: string) => process.stderr.write(`[stack] ${line}\n`);

/** Spawn a node child and resolve once a stdout line matches ready. */
function start(name: string, args: string[], env: NodeJS.ProcessEnv, ready: RegExp): Promise<ChildProcess> {
  const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[${name}] ${d.toString()}`));
  return new Promise((resolve, reject) => {
    let out = "";
    const onData = (d: Buffer) => {
      out += d.toString();
      if (ready.test(out)) {
        child.stdout?.off("data", onData);
        resolve(child);
      }
    };
    child.stdout?.on("data", onData);
    child.once("exit", (code) => reject(new Error(`${name} exited ${String(code)} before it was ready`)));
  });
}

function stopChild(child: ChildProcess | null): Promise<void> {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

const fake = await start("fake", ["test/fake-ollama/main.ts", "--port", String(FAKE_PORT), "--gpu-state", gpuState], process.env, /fake ollama on /);

let server: ChildProcess | null = null;

function serverEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GATES_LOCAL_OLLAMA_URL: FAKE_URL,
    GATES_LOCAL_NVIDIA_SMI: path.join(ROOT, "test/fake-ollama/nvidia-smi.ts"),
    GATES_LOCAL_FAKE_GPU_STATE: gpuState,
    GATES_LOCAL_MEMINFO: path.join(ROOT, "test/fake-ollama/meminfo.txt"),
    GATES_LOCAL_SERVER_TOKEN: TOKEN,
    GATES_LOCAL_ALLOWED_ORIGINS: WEB_ORIGIN,
    GATES_LOCAL_RUNTIME: "discover-only",
    GATES_LOCAL_OLLAMA_BINARY: "none",
    XDG_DATA_HOME: path.join(runDir, "xdg"),
  };
}

async function startServer(): Promise<void> {
  server = await start("server", ["apps/server/src/main.ts", "--port", String(SERVER_PORT), "--data-dir", dataDir], serverEnv(), /"ready":true/);
}

/** What /reset may write before the server starts. */
type Seed =
  | { readonly kind: "none" }
  | { readonly kind: "long"; readonly messages: number; readonly at: number }
  | { readonly kind: "design" | "readme"; readonly at: number };

/** Restart on a fresh data dir, seeding threads (and saved settings) first when asked; returns the seeded thread's id. */
async function freshServer(seed: Seed = { kind: "none" }, runtimeMode?: Settings["runtimeMode"]): Promise<string | null> {
  await stopChild(server);
  resets += 1;
  dataDir = path.join(runDir, `data-${resets}`);
  mkdirSync(dataDir, { recursive: true });
  const db = path.join(dataDir, "threads.sqlite");
  if (runtimeMode !== undefined) {
    writeFileSync(path.join(dataDir, SETTINGS_FILE_NAME), JSON.stringify({ version: SETTINGS_FILE_VERSION, settings: defaultSettings(runtimeMode) }));
  }
  const threadId =
    seed.kind === "long" ? seedLong(db, seed.messages, seed.at, "A long thread")
    : seed.kind === "design" ? seedDesign(db, seed.at)
    : seed.kind === "readme" ? seedReadme(db, seed.at)
    : null;
  await startServer();
  return threadId;
}

function seedOf(body: Record<string, unknown>): Seed {
  const at = typeof body["seedAt"] === "number" ? body["seedAt"] : Date.now();
  if (body["seed"] === "design" || body["seed"] === "readme") return { kind: body["seed"], at };
  if (typeof body["seed"] === "number" && body["seed"] > 0) return { kind: "long", messages: body["seed"], at };
  return { kind: "none" };
}

async function fakeScenario(body: unknown): Promise<void> {
  const r = await fetch(`${FAKE_URL}/__fake/scenario`, { method: "POST", body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`fake scenario: ${r.status} ${await r.text()}`);
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (c: Buffer) => (text += c.toString()));
    req.on("end", () => {
      try {
        const v: unknown = text === "" ? {} : JSON.parse(text);
        resolve(typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
  });
}

await freshServer();

// one control request at a time, so a reset never races a restart
let queue = Promise.resolve();
const control = createServer((req, res) => {
  queue = queue.then(async () => {
    const route = `${req.method} ${req.url?.split("?")[0]}`;
    try {
      if (route === "GET /health") {
        res.writeHead(200).end("ok");
      } else if (route === "POST /reset") {
        const body = await readJson(req);
        const { seed: _seed, seedAt: _at, runtimeMode, ...fakeBody } = body;
        await fakeScenario({ scenario: "models", ...fakeBody });
        const threadId = await freshServer(seedOf(body), runtimeMode === "system" || runtimeMode === "app" ? runtimeMode : undefined);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ dataDir, threadId }));
      } else if (route === "POST /restart") {
        const body = await readJson(req);
        await stopChild(server);
        await new Promise((r) => setTimeout(r, typeof body["downMs"] === "number" ? body["downMs"] : 0));
        await startServer();
        res.writeHead(200).end("ok");
      } else if (route === "POST /scenario") {
        await fakeScenario(await readJson(req));
        res.writeHead(200).end("ok");
      } else {
        res.writeHead(404).end("not found");
      }
    } catch (e) {
      log(`${route} failed: ${(e as Error).message}`);
      res.writeHead(500).end((e as Error).message);
    }
  });
});
control.listen(CONTROL_PORT, "127.0.0.1", () => log(`control on ${CONTROL_PORT}; data under ${runDir}`));

const shutdown = () => {
  control.close();
  void Promise.all([stopChild(server), stopChild(fake)]).then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
