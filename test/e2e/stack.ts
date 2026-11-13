// The E2E backend Playwright starts as one webServer: the fake Ollama and the
// real server (apps/server/src/main.ts) as child processes, plus a small
// control endpoint the specs call between journeys.
//
//   GET  /health            200 once the fake and the server are up
//   POST /reset {scenario?, seed?, seedAt?, runtimeMode?, comfyUrl?, imageTool?, phone?, sandbox?, engine?, ...fakeOptions}
//                           (engine: fake-comfy's engine(), the app's own ComfyUI to set up;
//                           its address also serves the model downloads)
//                           (imageTool: true saves image generation and Tools ›
//                           Make images on; sandbox: "off" makes the shell
//                           sandbox's probe fail, as with no systemd user session)
//                           set the fake's scenario, then restart the server
//                           on a fresh data dir (rediscovers Ollama). seed: N
//                           writes one thread of N messages, seed: "design" the
//                           design's sidebar, seed: "readme" the README's demo
//                           threads, seed: "usage" the design's sidebar and a
//                           week of usage, seed: "work-fold" saved tool turns
//                           (test/e2e/seed.ts), all pinned to
//                           seedAt; installed: [names] sets the fake's installed
//                           models; runtimeMode ("system" | "app") writes saved
//                           settings in that mode, else first run picks it; the
//                           controlledRuntimePorts: true pins discovery to a
//                           fake-backed listener and checked-free adjacent ports;
//                           reply carries the open thread's id; phone: true also
//                           opens the phone listener (GATES_LOCAL_WEB_LISTEN) on a
//                           Unix socket in a short 0700 dir under ~/.cache and a
//                           Serve stand-in (serve-standin.ts) in front of it on a
//                           free port outside 5286..5289, for PHONE_USER from
//                           PHONE_ADDR at http://127.0.0.1:<port> (no
//                           GATES_LOCAL_WEB_PEERS, so the self-source check is
//                           the one tested); the reply carries phonePort
//                           (the stand-in's) and phoneSocket
//   POST /restart {downMs?} stop the server, wait, start it on the same data dir
//   POST /scenario {...}    forward to the fake's /__fake/scenario
//   POST /gpu {otherMib, totalMib?, none?, memGib?} forward to the fake's /__fake/gpu: another program's GPU memory,
//                           the card's size, or no NVIDIA GPU at all; memGib rewrites the server's meminfo
//                           (system memory) until the next reset
//
// The server exits on stdin EOF, so each child keeps a stdin pipe open for
// its whole life. Nothing here talks to a real Ollama, GPU or nvidia-smi, and
// the server never looks for an Ollama binary (GATES_LOCAL_OLLAMA_BINARY=none)
// or at this user's app data (XDG_DATA_HOME is the run's own), so the runtime
// states are the same on every machine.
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { createServer as createNetServer, type Server } from "node:net";
import { CONTROL_PORT, DATA_ROOT, FAKE_PORT, FAKE_URL, PHONE_ADDR, PHONE_USER, ROOT, SERVER_PORT, TOKEN, WEB_ORIGIN } from "./env.ts";
import type { Settings } from "@gates-local/contracts";
import { SETTINGS_FILE_NAME, SETTINGS_FILE_VERSION, defaultSettings } from "../../apps/server/src/settings/store.ts";
import { seedDesign, seedLong, seedReadme, seedUsage, seedWorkFold } from "./seed.ts";
import { type ServeStandIn, startServeStandIn } from "./serve-standin.ts";
import { e2eServerEntry } from "./server-entry.ts";
import { prepareLibraryFixture } from "./library-fixture.ts";

// Resolve before starting even the fakes: a missing fixture stops setup outright.
const SERVER_ENTRY = e2eServerEntry(ROOT);
const libraryFixture = prepareLibraryFixture();
const runDir = path.join(DATA_ROOT, new Date().toISOString().replaceAll(/[:.]/g, "-"));
// One per checkout, reused across runs, and short so the socket path stays
// under sun_path's 107 bytes. The server makes it 0700; a socket a killed run
// left is removed by the server's stale-socket rule.
const phoneDir = path.join(homedir(), ".cache", "gates-local-e2e", `phone-${createHash("sha256").update(ROOT).digest("hex").slice(0, 8)}`);
const phoneSocket = path.join(phoneDir, "phone.sock");
const gpuState = path.join(runDir, "gpu-state.json");
mkdirSync(runDir, { recursive: true });
/** The server's /proc/meminfo: the fixture's 32 GB until POST /gpu gives a memGib, and again at each reset. */
const meminfo = path.join(runDir, "meminfo.txt");
const MEMINFO_FIXTURE = readFileSync(path.join(ROOT, "test/fake-ollama/meminfo.txt"), "utf8");
writeFileSync(meminfo, MEMINFO_FIXTURE);
let resets = 0;
let dataDir = "";
/** Port 9 (discard) has no server on a test machine: a download there fails at once, on this computer. */
const NO_DOWNLOADS = "http://127.0.0.1:9";
let downloadOrigin = NO_DOWNLOADS;
/**
 * The ComfyUI address when a test sets none: port 1, where nothing listens. Without it the server
 * would use the machine's own ComfyUI on 8188 and start or stop comfyui.service.
 */
const NO_COMFY = "http://127.0.0.1:1";
/** The reset's fake image engine (GATES_LOCAL_IMAGE_ENGINE, as JSON), or "" for none. */
let engineKnob = "";
/** The stand-in machine's shell sandbox (test/fake-ollama/systemd-run.ts); a reset's `sandbox: "off"` breaks it. */
let sandbox: "ready" | "off" = "ready";

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

function stopChild(child: ChildProcess | null, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<void> {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill(signal);
  });
}

const fake = await start("fake", ["test/fake-ollama/main.ts", "--port", String(FAKE_PORT), "--gpu-state", gpuState], process.env, /fake ollama on /);

let server: ChildProcess | null = null;
let controlledRuntime: Awaited<ReturnType<typeof allocateRuntimePorts>> | undefined;
/** The Serve stand-in's port while a reset asked for the phone listener, else null. */
let phonePort: number | null = null;
let standIn: ServeStandIn | null = null;

/** A free loopback port the kernel picks, never one of the stack's fixed 5286..5289. */
async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createNetServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        const p = typeof address === "object" && address !== null ? address.port : 0;
        probe.close(() => resolve(p));
      });
    });
    if (port > 0 && (port < SERVER_PORT || port > CONTROL_PORT)) return port;
  }
}

function listen(listener: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(port, "127.0.0.1", () => { listener.off("error", reject); resolve(); });
  });
}
function close(listener: Server): Promise<void> {
  return new Promise(resolve => listener.close(() => resolve()));
}

/** A real fake-backed listener, followed by nine checked-free discovery ports. */
async function allocateRuntimePorts(target: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const proxy = createServer((req, res) => {
      const upstream = request(`${target}${req.url ?? "/"}`, { method: req.method, headers: req.headers }, response => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      });
      upstream.on("error", () => {
        if (res.destroyed) return;
        if (res.headersSent) res.destroy(); else res.writeHead(502).end("Fake transport failed");
      });
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    });
    await listen(proxy, 0);
    const address = proxy.address();
    const system = typeof address === "object" && address !== null ? address.port : 0;
    const leases: Server[] = [];
    let available = false;
    try {
      // Keep every discovery probe away from fixed service and fixture ports.
      if (system < 20000 || system + 9 > 65535) continue;
      for (let port = system + 1; port <= system + 9; port++) {
        const lease = createNetServer(socket => socket.destroy());
        await listen(lease, port);
        leases.push(lease);
      }
      available = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error;
    } finally {
      await Promise.all(leases.map(close));
      if (!available) { proxy.closeAllConnections(); await close(proxy); }
    }
    if (available) return {
      system, app: system + 1, url: `http://127.0.0.1:${system}`,
      close: async () => { proxy.closeAllConnections(); await close(proxy); },
    };
  }
  throw new Error("Could not allocate a controlled runtime discovery range");
}

function phoneEnv(): NodeJS.ProcessEnv {
  if (phonePort === null) return {};
  return {
    GATES_LOCAL_WEB_LISTEN: `unix:${phoneSocket}`,
    GATES_LOCAL_WEB_ORIGIN: `http://127.0.0.1:${phonePort}`,
    GATES_LOCAL_WEB_USER: PHONE_USER,
    GATES_LOCAL_WEB_ROOT: path.join(ROOT, "apps/web/dist"),
  };
}

function serverEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...phoneEnv(),
    GATES_LOCAL_OLLAMA_URL: controlledRuntime?.url ?? FAKE_URL,
    // A typed model name is looked up here, never ollama.com: the fake answers 404, "not in the library".
    GATES_LOCAL_OLLAMA_REGISTRY: FAKE_URL,
    GL_E2E_LIBRARY_FIXTURE: libraryFixture,
    GATES_LOCAL_NVIDIA_SMI: path.join(ROOT, "test/fake-ollama/nvidia-smi.ts"),
    GATES_LOCAL_FAKE_GPU_STATE: gpuState,
    GATES_LOCAL_MEMINFO: meminfo,
    // The shell sandbox's probe sees a stand-in machine, never the runner's own bwrap.
    GATES_LOCAL_SYSTEMD_RUN: path.join(ROOT, "test/fake-ollama/systemd-run.ts"),
    GL_FAKE_SANDBOX: sandbox,
    GATES_LOCAL_SERVER_TOKEN: TOKEN,
    GATES_LOCAL_ALLOWED_ORIGINS: WEB_ORIGIN,
    GATES_LOCAL_RUNTIME: "discover-only",
    GATES_LOCAL_OLLAMA_BINARY: "none",
    // Image model downloads come from the test's fake ComfyUI (it serves the files too), never
    // Hugging Face; with no fake, from a port nothing listens on.
    GATES_LOCAL_IMAGE_DOWNLOAD_ORIGIN: downloadOrigin,
    // A reset's comfyUrl (the fake's) is saved in Settings and wins over this.
    GATES_LOCAL_COMFY_URL: NO_COMFY,
    // The app's own ComfyUI, installed from the test's fake (fake-comfy.ts engine()), never the pinned release.
    GATES_LOCAL_IMAGE_ENGINE: engineKnob,
    XDG_DATA_HOME: path.join(runDir, "xdg"),
    // The server runs from this checkout; with the root here, a Check for
    // updates in a test is refused before any git command runs on it.
    GATES_LOCAL_UPDATE_TEST_ROOT: runDir,
    // Windows keeps the app's shared data under %LOCALAPPDATA%, not XDG_DATA_HOME.
    ...(process.platform === "win32" ? { LOCALAPPDATA: path.join(runDir, "localappdata") } : {}),
  };
}

async function startServer(): Promise<void> {
  server = await start("server", [SERVER_ENTRY, "--port", String(SERVER_PORT), "--data-dir", dataDir], serverEnv(), /"ready":true/);
}

/** What /reset may write before the server starts. */
type Seed =
  | { readonly kind: "none" }
  | { readonly kind: "long"; readonly messages: number; readonly at: number }
  | { readonly kind: "design"; readonly at: number; readonly code?: boolean }
  | { readonly kind: "readme"; readonly at: number }
  | { readonly kind: "usage"; readonly at: number }
  | { readonly kind: "work-fold"; readonly at: number };

/** Restart on a fresh data dir, seeding threads (and saved settings) first when asked; returns the seeded thread's id. */
async function freshServer(seed: Seed = { kind: "none" }, runtimeMode?: Settings["runtimeMode"], comfyUrl?: string, imageTool = false, engine?: { address: string }): Promise<string | null> {
  await stopChild(server);
  downloadOrigin = comfyUrl ?? engine?.address ?? NO_DOWNLOADS;
  engineKnob = engine === undefined ? "" : JSON.stringify(engine);
  resets += 1;
  dataDir = path.join(runDir, `data-${resets}`);
  mkdirSync(dataDir, { recursive: true });
  const db = path.join(dataDir, "threads.sqlite");
  if (runtimeMode !== undefined || comfyUrl !== undefined || imageTool) {
    const settings = { ...defaultSettings(runtimeMode ?? "system"), ...(comfyUrl === undefined ? {} : { comfyUrl }), ...(imageTool ? { imageGen: true, imageTool: true } : {}) };
    writeFileSync(path.join(dataDir, SETTINGS_FILE_NAME), JSON.stringify({ version: SETTINGS_FILE_VERSION, settings }));
  }
  const threadId =
    seed.kind === "long" ? seedLong(db, seed.messages, seed.at, "A long thread")
    : seed.kind === "design" ? seedDesign(db, seed.at, seed.code)
    : seed.kind === "readme" ? seedReadme(db, seed.at)
    : seed.kind === "usage" ? seedUsage(db, path.join(dataDir, "usage.sqlite"), seed.at)
    : seed.kind === "work-fold" ? seedWorkFold(db, seed.at)
    : null;
  await startServer();
  return threadId;
}

function seedOf(body: Record<string, unknown>): Seed {
  const at = typeof body["seedAt"] === "number" ? body["seedAt"] : Date.now();
  if (body["seed"] === "design" || body["seed"] === "readme" || body["seed"] === "usage" || body["seed"] === "work-fold") return { kind: body["seed"], at };
  if (body["seed"] === "design-code") return { kind: "design", at, code: true };
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
        const { seed: _seed, seedAt: _at, runtimeMode, comfyUrl, imageTool, phone, controlledRuntimePorts, sandbox: sandboxState, engine, ...fakeBody } = body;
        const fakeEngine = typeof engine === "object" && engine !== null && typeof (engine as { address?: unknown }).address === "string" ? engine as { address: string } : undefined;
        sandbox = sandboxState === "off" ? "off" : "ready";
        writeFileSync(meminfo, MEMINFO_FIXTURE);
        await stopChild(server);
        server = null;
        await controlledRuntime?.close();
        controlledRuntime = undefined;
        if (controlledRuntimePorts === true) controlledRuntime = await allocateRuntimePorts(FAKE_URL);
        await fakeScenario({ scenario: "models", ...fakeBody });
        await standIn?.close();
        standIn = null;
        phonePort = phone === true ? await freePort() : null;
        const threadId = await freshServer(seedOf(body), runtimeMode === "system" || runtimeMode === "app" ? runtimeMode : undefined, typeof comfyUrl === "string" ? comfyUrl : undefined, imageTool === true, fakeEngine);
        if (phonePort !== null) standIn = await startServeStandIn(phonePort, phoneSocket, PHONE_USER, PHONE_ADDR);
        const reply = phonePort === null ? { dataDir, threadId, phonePort } : { dataDir, threadId, phonePort, phoneSocket };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
      } else if (route === "POST /runtime-ports") {
        if (!controlledRuntime) throw new Error("This reset did not request controlled runtime ports");
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ system: controlledRuntime.system, app: controlledRuntime.app }));
      } else if (route === "POST /restart") {
        const body = await readJson(req);
        // crash: SIGKILL, so the server says nothing on its way out (no push ends what it was doing)
        await stopChild(server, body["crash"] === true ? "SIGKILL" : "SIGTERM");
        await new Promise((r) => setTimeout(r, typeof body["downMs"] === "number" ? body["downMs"] : 0));
        await startServer();
        res.writeHead(200).end("ok");
      } else if (route === "POST /scenario") {
        await fakeScenario(await readJson(req));
        res.writeHead(200).end("ok");
      } else if (route === "POST /gpu") {
        const { memGib, ...gpu } = await readJson(req);
        if (memGib !== undefined) {
          if (typeof memGib !== "number" || !(memGib > 0)) throw new Error("memGib must be a number of GiB above 0");
          const kb = Math.round(memGib * 1024 * 1024);
          writeFileSync(meminfo, `MemTotal: ${kb} kB\nMemAvailable: ${Math.round(kb / 2)} kB\n`);
        }
        const r = await fetch(`${FAKE_URL}/__fake/gpu`, { method: "POST", body: JSON.stringify(gpu) });
        if (!r.ok) throw new Error(`fake gpu: ${r.status} ${await r.text()}`);
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
  void Promise.all([stopChild(server), stopChild(fake), standIn?.close(), controlledRuntime?.close()]).then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
