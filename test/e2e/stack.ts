// The E2E backend Playwright starts as one webServer: the fake Ollama and the
// real server (apps/server/src/main.ts) as child processes, plus a small
// control endpoint the specs call between journeys.
//
//   GET  /health            200 once the fake and the server are up
//   POST /reset {scenario?, seed?, ...fakeOptions}
//                           set the fake's scenario, then restart the server
//                           on a fresh data dir (rediscovers Ollama); seed: N
//                           writes one thread of N messages first and the
//                           reply carries its threadId
//   POST /restart {downMs?} stop the server, wait, start it on the same data dir
//   POST /scenario {...}    forward to the fake's /__fake/scenario
//
// The server exits on stdin EOF, so each child keeps a stdin pipe open for
// its whole life. Nothing here talks to a real Ollama, GPU or nvidia-smi.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import path from "node:path";
import { openThreadStore } from "../../apps/server/src/threads/store.ts";
import { CONTROL_PORT, DATA_ROOT, FAKE_PORT, FAKE_URL, ROOT, SERVER_PORT, TOKEN, WEB_ORIGIN } from "./env.ts";

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
  };
}

async function startServer(): Promise<void> {
  server = await start("server", ["apps/server/src/main.ts", "--port", String(SERVER_PORT), "--data-dir", dataDir], serverEnv(), /"ready":true/);
}

const SEED_REPLY = [
  "Here is the short version.",
  "",
  "- **cron** reads its own `PATH`, not your shell's",
  "- set it at the top of the crontab, or use full paths",
  "",
  "```sh",
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "```",
  "",
  "That covers most cases where a job runs by hand but not on schedule.",
].join("\n");

/** Write one thread of `messages` alternating messages with the server's own store; returns its id. */
function seedThread(messages: number): string {
  const store = openThreadStore(path.join(dataDir, "threads.sqlite"));
  try {
    const t = store.createThread({ title: "A long thread" });
    const first = Date.now() - messages * 60_000;
    for (let i = 0; i < messages; i++) {
      const user = i % 2 === 0;
      store.appendMessage({
        threadId: t.id,
        role: user ? "user" : "assistant",
        content: user ? `Question ${i / 2 + 1}: why does my cron job not find node?` : SEED_REPLY,
        createdAt: first + i * 60_000,
        ...(user ? {} : { model: "qwen3.5:9b", thinking: "Short question, plain answer.", stats: { promptTokens: 400 + i, completionTokens: 120, durationMs: 1500 } }),
      });
    }
    return t.id;
  } finally {
    store.close();
  }
}

/** Restart on a fresh data dir, seeding a thread first when asked. */
async function freshServer(seed = 0): Promise<string | null> {
  await stopChild(server);
  resets += 1;
  dataDir = path.join(runDir, `data-${resets}`);
  mkdirSync(dataDir, { recursive: true });
  const threadId = seed > 0 ? seedThread(seed) : null;
  await startServer();
  return threadId;
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
        const { seed, ...fakeBody } = await readJson(req);
        await fakeScenario({ scenario: "models", ...fakeBody });
        const threadId = await freshServer(typeof seed === "number" ? seed : 0);
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
