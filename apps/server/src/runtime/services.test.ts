// createModelServices wired end to end with fakes: a fake `ollama` binary in
// the data dir, fake Ollama HTTP servers, fake nvidia-smi and meminfo. The
// GPU watcher is stopped at once so nothing reads systemd or the real GPU.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type AppDeps } from "../app.ts";
import { json, startFakeServer, type FakeServer, type Route } from "../fit/fake-http.ts";
import type { ImageModule } from "../image/module.ts";
import { openThreadStore } from "../threads/store.ts";
import { httpGet } from "./http.ts";
import { appModelsDir, installedBinary } from "./paths.ts";
import { createGpuLease, type GpuLease } from "../gpu/lease.ts";
import { createModelServices, type ModelServices } from "./services.ts";
import { freePort, freePortRun, removeDir, tmpDir, writeFakeBinary } from "./test-fakes.ts";
import { ownedIdleComfy, type OwnedComfy } from "./test-image.ts";
import type { ModelLoad, SyncChange } from "@gates-local/contracts";

const VERSION = "9.9.9-services";
const manifest = { version: VERSION, url: "http://127.0.0.1:1/never", sha256: "0".repeat(64), sizeBytes: 1, format: "tar.zst", verified: true, source: "test" } as const;
const SHOW = JSON.parse(readFileSync(new URL("../fit/fixtures/show-qwen3-5-9b.json", import.meta.url), "utf8")) as unknown;
const fit = {
  runNvidiaSmi: async (args: readonly string[]) => (args[0]?.startsWith("--query-gpu") ? "16303, 1303, 15000\n" : ""),
  readMeminfo: async () => "MemAvailable: 30000000 kB\n",
};

let work: string;
const open: ModelServices[] = [];
const servers: FakeServer[] = [];
beforeEach(() => {
  work = tmpDir("services");
});
afterEach(async () => {
  for (const s of open.splice(0)) await s.close({ stopRuntime: true });
  for (const s of servers.splice(0)) await s.close();
  removeDir(work);
});

const nothingAt = async () => `http://127.0.0.1:${await freePort()}`;
/** The fake binary's OLLAMA_MODELS. */
async function models(url: string): Promise<string | undefined> {
  const r = await httpGet(`${url}/fake/env`, 1000);
  return r.kind === "response" ? (JSON.parse(r.body) as { OLLAMA_MODELS: string }).OLLAMA_MODELS : undefined;
}

async function services(dataDir: string, runtime: Record<string, unknown>, lease?: GpuLease, turnDrainMs?: number, fitDeps: AppDeps["fit"] = fit) {
  const home = path.join(work, "home");
  const settingsFrames: Array<{ value: unknown; changes: readonly SyncChange[] | undefined }> = [];
  const modelLoads: ModelLoad[] = [];
  const s = await createModelServices({
    dataDir,
    push: (channel, value, changes) => {
      if (channel === "settings.changed") settingsFrames.push({ value, changes });
      if (channel === "models.load") modelLoads.push(value as ModelLoad);
    },
    runtime: { home, env: { PATH: "", HOME: home }, systemModelsDirs: [], allowInstall: false, probeTimeoutMs: 500, manifest, ...runtime },
    fit: fitDeps,
    log: () => undefined,
    ...(lease ? { lease } : {}),
    ...(turnDrainMs === undefined ? {} : { turnDrainMs }),
  });
  s.gpu.stop();
  open.push(s);
  return Object.assign(s, { settingsFrames, modelLoads });
}

it("S-08: two services with different data dirs run their own Ollama against their own models folder", async () => {
  const base = await freePortRun(2);
  const a = path.join(work, "instance-a");
  const b = path.join(work, "instance-b");
  for (const dir of [a, b]) writeFakeBinary(installedBinary(dir, VERSION));
  const external = await nothingAt();
  const sa = await services(a, { appPort: base, externalBaseUrl: external });
  const sb = await services(b, { appPort: base, externalBaseUrl: external });
  expect(sa.settings.get().runtimeMode).toBe("app");
  const ra = await sa.runtime.ensure();
  const rb = await sb.runtime.ensure();
  expect([ra.state, rb.state]).toEqual(["ready", "ready"]);
  expect(await models(ra.baseUrl)).toBe(appModelsDir(a));
  expect(await models(rb.baseUrl)).toBe(appModelsDir(b));
});

it("an image may unload a model the app never loaded only from an Ollama the app started", async () => {
  const MODEL = "qwen3.5:9b";
  const external = await startFakeServer({
    "GET /": (_b, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("Ollama is running"); },
    "GET /api/version": (_b, res) => json(res, 200, { version: "0.0.9-fake" }),
    "GET /api/tags": (_b, res) => json(res, 200, { models: [] }),
    "GET /api/ps": (_b, res) => json(res, 200, { models: [{ name: MODEL, size: 1, size_vram: 1, context_length: 16384 }] }),
  });
  servers.push(external);
  const system = await services(path.join(work, "data-system"), { appPort: await freePort(), externalBaseUrl: external.baseUrl });
  expect((await system.runtime.ensure()).owner).toBe("external");
  expect(await system.loader.imageMayUnload()).toEqual([]);

  const dataDir = path.join(work, "data-app");
  writeFakeBinary(installedBinary(dataDir, VERSION), loadableOllamaScript(MODEL));
  const app = await services(dataDir, { appPort: await freePort(), externalBaseUrl: await nothingAt() });
  const status = await app.runtime.ensure();
  expect(status.owner).toBe("app");
  // Resident, but not through the app's loader (a load from an earlier run of the app).
  await (await fetch(new URL("/api/generate", status.baseUrl), { method: "POST", body: JSON.stringify({ model: MODEL, prompt: "" }) })).text();
  expect(app.loader.appLoadedModels()).toEqual([]);
  expect(await app.loader.imageMayUnload()).toEqual([MODEL]);
});

it("S-02: a preload's fit reads the URL the load captured, not whatever the runtime says later", async () => {
  // A system Ollama whose root stops answering like Ollama mid-load: the
  // runtime's next discover drops its base URL, but the load already chose it.
  let healthy = true;
  let releasePs!: () => void;
  const psHeld = new Promise<void>((r) => (releasePs = r));
  let firstPs = true;
  const ollama = await startFakeServer({
    "GET /": (_b, res) => {
      if (!healthy) return json(res, 500, { error: "down" });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Ollama is running");
    },
    "GET /api/version": (_b, res) => json(res, 200, { version: "0.0.9-fake" }),
    // Installed, so the fit goes on to /api/show (the request this test watches for).
    "GET /api/tags": (_b, res) => json(res, 200, { models: [{ name: "qwen3.5:9b", size: 6_600_000_000, digest: "d", modified_at: "2026-11-01T00:00:00Z" }] }),
    "GET /api/ps": async (_b, res) => {
      if (firstPs) {
        firstPs = false;
        await psHeld;
      }
      json(res, 200, { models: [] });
    },
    "POST /api/show": (_b, res) => json(res, 200, SHOW),
    "POST /api/generate": (b, res) => json(res, 200, { model: (b as { model: string }).model, response: "", done: true }),
  });
  servers.push(ollama);
  const s = await services(path.join(work, "data"), { appPort: await freePort(), externalBaseUrl: ollama.baseUrl });
  expect(s.settings.get().runtimeMode).toBe("system");
  expect((await s.runtime.ensure()).state).toBe("ready");
  const loading = s.loader.load("qwen3.5:9b", 16384);
  await until(() => !firstPs);
  healthy = false;
  await s.runtime.discover();
  expect(s.runtime.baseUrl()).toBeUndefined();
  releasePs();
  const r = await loading;
  expect(ollama.requests.some((q) => q.path === "/api/show")).toBe(true);
  expect(r).toMatchObject({ state: "ready" });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = (ready: () => boolean) => vi.waitFor(() => expect(ready()).toBe(true), { timeout: 20_000 });
/** A promise and the function that resolves it. */
function signalled(): { promise: Promise<void>; resolve: () => void } {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, resolve: () => release?.() };
}
async function settled<T>(p: Promise<T>, what: string, ms = 20_000): Promise<unknown> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then((v) => ({ resolved: v }), (e: unknown) => ({ rejected: e })),
      new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), ms); }),
    ]);
  } finally { clearTimeout(deadline); }
}

/**
 * The app runtime's fake `ollama` for a load: one model installed, /api/show answers, a
 * preload makes it resident and keep_alive 0 lets it go.
 */
function loadableOllamaScript(model: string): string {
  return `#!${process.execPath}
const http = require("node:http");
const [cmd] = process.argv.slice(2);
if (cmd === "--version" || cmd === "-v") { console.log("ollama version is 0.0.3-fake-app"); process.exit(0); }
if (cmd !== "serve") process.exit(2);
const [host, port] = (process.env.OLLAMA_HOST || "").split(":");
const show = ${JSON.stringify(SHOW)};
const loaded = [];
const server = http.createServer((req, res) => {
  const json = (b) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const b = JSON.parse(body || "{}");
    if (req.url === "/") { res.writeHead(200); res.end("Ollama is running"); }
    else if (req.url === "/api/version") json({ version: "0.0.3-fake-app" });
    else if (req.url === "/api/tags") json({ models: [{ name: ${JSON.stringify(model)}, size: 6600000000, digest: "d", modified_at: "2026-11-01T00:00:00Z" }] });
    else if (req.url === "/api/ps") json({ models: loaded.map((name) => ({ name, size: 1, size_vram: 1, context_length: 16384 })) });
    else if (req.url === "/api/show") json(show);
    else if (req.url === "/api/generate") {
      if (b.keep_alive === 0) loaded.splice(0, loaded.length, ...loaded.filter((m) => m !== b.model));
      else if (!loaded.includes(b.model)) loaded.push(b.model);
      json({ model: b.model, response: "", done: true });
    } else { res.writeHead(404); res.end(); }
  });
});
server.listen(Number(port), host);
process.on("SIGTERM", () => { server.close(); process.exit(0); });
`;
}

it("a GPU reading of the old runtime that answers after a switch leaves the new runtime's loaded models alone", async () => {
  // The old runtime: a system Ollama whose /api/ps the GPU watcher's read waits on.
  let holdPs = false;
  const psAsked = signalled();
  const psAnswer = signalled();
  const old = await startFakeServer({
    "GET /": (_b, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Ollama is running");
    },
    "GET /api/version": (_b, res) => json(res, 200, { version: "0.0.9-fake" }),
    "GET /api/tags": (_b, res) => json(res, 200, { models: [] }),
    "GET /api/ps": async (_b, res) => {
      if (holdPs) {
        holdPs = false;
        psAsked.resolve();
        await psAnswer.promise;
      }
      json(res, 200, { models: [] });
    },
  });
  servers.push(old);
  const dataDir = path.join(work, "data");
  writeFakeBinary(installedBinary(dataDir, VERSION), loadableOllamaScript(MODEL));
  // The status query gets no answer it can read (so the reading never asks systemd about
  // whisper); the fit's own query sees 15 GB free.
  const fitDeps = { ...fit, runNvidiaSmi: async (args: readonly string[]) => (args[0]?.startsWith("--query-gpu=memory") ? "16303, 1303, 15000\n" : "") };
  const s = await services(dataDir, { appPort: await freePort(), externalBaseUrl: old.baseUrl }, undefined, undefined, fitDeps);
  expect(s.runtime.mode()).toBe("system");
  expect((await s.runtime.ensure()).state).toBe("ready");

  holdPs = true;
  const reading = s.gpu.read();
  try {
    expect(await settled(psAsked.promise, "the watcher's /api/ps to the old runtime")).toEqual({ resolved: undefined });
    expect(await s.runtime.setMode("app")).toMatchObject({ state: "ready" });
    expect(await s.loader.load(MODEL, 16384)).toMatchObject({ state: "ready" });
    expect(s.loader.appLoadedModels()).toEqual([MODEL]);
  } finally {
    // The old runtime's answer (nothing loaded there) arrives now, after the switch and the load.
    psAnswer.resolve();
  }
  await settled(reading, "the GPU reading");
  const unloaded = s.modelLoads.filter((l) => l.state === "unloaded");
  expect({ owned: s.loader.appLoadedModels(), unloaded }).toEqual({ owned: [MODEL], unloaded: [] });
});

describe("R2-02: shutdown aborts a preload in its residency read or its fit", () => {
  for (const where of ["/api/ps", "/api/show"] as const) {
    it(`a request to ${where} that never answers ends when the loader and image close`, async () => {
      const hungAt = signalled();
      const hung = hungAt.promise;
      const aborted = signalled();
      const never: Route = (_body, res) => {
        res.once("close", aborted.resolve);
        hungAt.resolve();
        return new Promise<void>(() => undefined);
      };
      const ollama = await startFakeServer({
        "GET /": (_b, res) => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("Ollama is running");
        },
        "GET /api/version": (_b, res) => json(res, 200, { version: "0.0.9-fake" }),
        "GET /api/tags": (_b, res) => json(res, 200, { models: [{ name: "qwen3.5:9b", size: 6_600_000_000, digest: "d", modified_at: "2026-11-01T00:00:00Z" }] }),
        "GET /api/ps": where === "/api/ps" ? never : (_b, res) => json(res, 200, { models: [] }),
        "POST /api/show": where === "/api/show" ? never : (_b, res) => json(res, 200, SHOW),
        "POST /api/generate": (b, res) => json(res, 200, { model: (b as { model: string }).model, response: "", done: true }),
      });
      servers.push(ollama);
      const lease = createGpuLease();
      const comfy = await ownedIdleComfy(lease, work);
      const s = await services(path.join(work, "data"), { appPort: await freePort(), externalBaseUrl: ollama.baseUrl }, lease);
      expect((await s.runtime.ensure()).state).toBe("ready");
      const loading = s.loader.load("qwen3.5:9b", 16384);
      expect(await settled(hung, "held runtime request readiness")).toEqual({ resolved: undefined });
      // main.ts: cancel turns, drain model loads, close image module.
      const shutdown = (async () => {
        await s.loader.close();
        await comfy.image.close();
      })();
      expect(await settled(aborted.promise, `shutdown aborting ${where}`, 2000)).toEqual({ resolved: undefined });
      expect(await settled(shutdown, "application shutdown")).toEqual({ resolved: undefined });
      expect(await loading).toMatchObject({ state: "error" });
      expect(comfy.stops()).toBe(1);
      expect(lease.status()).toEqual({ holder: null, holders: 0, waiting: [] });
      expect(ollama.requests.some((q) => q.path === "/api/generate")).toBe(false);
      comfy.close();
    });
  }
});

const line = (v: unknown) => `${JSON.stringify(v)}\n`;
const expectRuntimeChangedEnd = (events: { type: string; code?: string; message?: string }[]) => {
  const last = events.at(-1);
  expect(last).toMatchObject({ type: "error", code: "runtime-changed" });
  expect(last?.message).toMatch(/runtime changed/i);
  expect(last?.message).toMatch(/send (the|your) message again/i);
};

const MODEL = "qwen3.5:9b";
/** nvidia-smi on a 16303 MiB GPU with `freeMib` free and no compute apps listed. */
const smi = (freeMib: number) => async (args: readonly string[]) => (args[0]?.startsWith("--query-gpu") ? `16303, ${16303 - freeMib}, ${freeMib}\n` : "");
/** An /api/ps entry resident at 16k. */
const entry = (name: string, vram: number) => ({ name, size: vram, size_vram: vram, context_length: 16384 });
/**
 * About 1 GB free, RAM under its margin, and the idle app-owned ComfyUI (MainPID 4242) holding
 * `comfyMib`, which nvidia-smi gives back once it is stopped.
 */
function withComfyToo(comfy: OwnedComfy, comfyMib: number) {
  return {
    readMeminfo: async () => "MemAvailable: 1000000 kB\n",
    runNvidiaSmi: async (args: readonly string[]) => {
      const up = comfy.stops() === 0;
      if (args[0]?.startsWith("--query-gpu")) {
        const free = 1000 + (up ? 0 : comfyMib);
        return `16303, ${16303 - free}, ${free}\n`;
      }
      return up ? `4242, /usr/bin/python3 main.py --port 8188, ${comfyMib}\n` : "";
    },
  };
}

interface RigOptions {
  readonly image?: ImageModule;
  readonly lease?: GpuLease;
  /** The fit readings the app's turns use (default: plenty of free VRAM). */
  readonly fit?: AppDeps["fit"];
  readonly turnDrainMs?: number;
  /** Runs inside the app's push of each chat event, before the turn takes its next step. */
  readonly onEvent?: (event: { type: string }) => void;
}

/**
 * A system Ollama with MODEL resident at 16k (the fit is measured, no /api/show) unless the
 * routes say otherwise, the services and the app around it, sharing one lease when given.
 */
async function rig(routes: Record<string, Route>, options: RigOptions = {}) {
  const old = await startFakeServer({
    "GET /": (_b, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Ollama is running");
    },
    "GET /api/version": (_b, res) => json(res, 200, { version: "0.0.9-fake" }),
    "GET /api/tags": (_b, res) => json(res, 200, { models: [{ name: MODEL, size: 6_600_000_000, digest: "d", modified_at: "2026-11-01T00:00:00Z" }] }),
    // Wholly on the GPU and at least its weights: a measurement of the whole model.
    "GET /api/ps": (_b, res) => json(res, 200, { models: [{ name: MODEL, size: 7_000_000_000, size_vram: 7_000_000_000, context_length: 16384 }] }),
    "POST /api/show": (_b, res) => json(res, 200, SHOW),
    ...routes,
  });
  servers.push(old);
  // The preloads (models.load) read the machine the way the turns do.
  const s = await services(path.join(work, "data"), { appPort: await freePort(), externalBaseUrl: old.baseUrl }, options.lease, options.turnDrainMs, options.fit ?? fit);
  expect(s.runtime.mode()).toBe("system");
  expect((await s.runtime.ensure()).state).toBe("ready");
  const store = openThreadStore(path.join(work, "threads.sqlite"));
  const events: { turnId: string; type: string; code?: string; message?: string; text?: string; neededBy?: string; partial?: { id: string; content: string; thinking?: string } }[] = [];
  const app = createApp({
    store,
    runtime: s.runtime,
    catalog: s.catalog,
    push: (channel, payload) => {
      if (channel === "chat.event") {
        const { turnId, event } = payload as { turnId: string; event: { type: string } };
        events.push({ ...event, turnId });
        options.onEvent?.(event);
      }
    },
    models: { handlers: s.handlers, loader: s.loader },
    fit: options.fit ?? fit,
    // With an image module the chat model is offered the image tool (Tools › Make images on).
    ...(options.image ? { image: options.image, toolsEnabled: () => true, imageTool: () => ({ preset: "sdxl-lightning-pixel", width: 768, height: 512 }) } : {}),
    ...(options.lease ? { lease: options.lease } : {}),
    log: () => undefined,
  });
  const thread = store.createThread({});
  const chats = () => old.requests.filter((r) => r.method === "POST" && r.path === "/api/chat").length;
  const done = async () => {
    await app.shutdown();
    store.close();
  };
  return { old, s, app, store, thread, events, chats, done };
}

describe("R2-03: a runtime switch ends every turn reserved against the old runtime", () => {

  it("held capability lookup: switch, release it, and no /api/chat reaches the old runtime", async () => {
    const show = signalled();
    const asked = signalled();
    const r = await rig({
      "POST /api/show": async (_b, res) => {
        asked.resolve();
        await show.promise;
        json(res, 200, SHOW);
      },
    });
    const { turnId } = await r.app.handlers["chat.send"]({ threadId: r.thread.id, content: "hello", model: MODEL, numCtx: 16384, think: true }, { clientId: 1 });
    expect(turnId).toBeTruthy();
    expect(await settled(asked.promise, "held request readiness")).toEqual({ resolved: undefined });
    const switching = r.s.runtime.setMode("app");
    await until(() => r.s.runtime.baseUrl() === undefined);
    show.resolve();
    await switching;
    await until(() => r.app.activeTurns() === 0);
    expect(r.chats()).toBe(0);
    expect(r.app.activeTurns()).toBe(0);
    expectRuntimeChangedEnd(r.events);
    // Only the user message: the reply never started.
    expect(r.store.getThread(r.thread.id).messages.map((m) => m.role)).toEqual(["user"]);
    await r.done();
  });

  it("tool round: switch while the tool runs, release it, and the next /api/chat never reaches the old runtime", async () => {
    const tool = signalled();
    const queuedOnce = signalled();
    let queued = 0;
    const image = {
      current: () => ({ state: "off", owner: "none" }),
      generate: async () => {
        queued++;
        queuedOnce.resolve();
        await tool.promise;
        return { jobId: "job-1" };
      },
      cancel: () => ({ cancelled: true }),
    } as unknown as ImageModule;
    const r = await rig(
      {
        "POST /api/show": (_b, res) => json(res, 200, { ...(SHOW as object), capabilities: ["completion", "tools"] }),
        "POST /api/chat": (_b, res) => {
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          res.end(line({ model: MODEL, message: { role: "assistant", content: "", tool_calls: [{ function: { name: "image", arguments: { prompt: "a cat" } } }] }, done: true, done_reason: "stop" }));
        },
      },
      { image },
    );
    await r.app.handlers["chat.send"]({ threadId: r.thread.id, content: "draw a cat", model: MODEL, numCtx: 16384 }, { clientId: 1 });
    expect(await settled(queuedOnce.promise, "tool request readiness")).toEqual({ resolved: undefined });
    expect([queued, r.chats()]).toEqual([1, 1]);
    const switching = r.s.runtime.setMode("app");
    await until(() => r.s.runtime.baseUrl() === undefined);
    tool.resolve();
    await switching;
    await until(() => r.app.activeTurns() === 0);
    expect(r.chats()).toBe(1);
    expect(r.app.activeTurns()).toBe(0);
    expectRuntimeChangedEnd(r.events);
    const kept = r.store.getThread(r.thread.id).messages;
    expect(kept.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(kept[1]).toMatchObject({ content: "", tools: [{ name: "image", state: "error" }] });
    await r.done();
  });

  it("a tool that never lets go: the switch ends the turn now (one runtime-changed, GPU claim released) and completes; the tool's late result is dropped", async () => {
    const tool = signalled();
    const queuedOnce = signalled();
    const aborted = signalled();
    const cancelled: string[] = [];
    const image = {
      current: () => ({ state: "off", owner: "none" }),
      generate: async () => {
        queuedOnce.resolve();
        await tool.promise;
        return { jobId: "job-late" };
      },
      cancel: (jobId: string) => {
        cancelled.push(jobId);
        return { cancelled: true };
      },
    } as unknown as ImageModule;
    const lease = createGpuLease();
    const r = await rig(
      {
        "POST /api/show": (_b, res) => json(res, 200, { ...(SHOW as object), capabilities: ["completion", "tools"] }),
        "POST /api/chat": (_b, res) => {
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          res.end(line({ model: MODEL, message: { role: "assistant", content: "", tool_calls: [{ function: { name: "image", arguments: { prompt: "a cat" } } }] }, done: true, done_reason: "stop" }));
        },
      },
      { image, lease, turnDrainMs: 15_000, onEvent: event => { if (event.type === "error") aborted.resolve(); } },
    );
    await r.app.handlers["chat.send"]({ threadId: r.thread.id, content: "draw a cat", model: MODEL, numCtx: 16384 }, { clientId: 1 });
    expect(await settled(queuedOnce.promise, "tool request readiness")).toEqual({ resolved: undefined });
    expect(lease.status().holders).toBe(1);
    // The held tool must be aborted before the 15-second turn-drain fallback.
    const switching = r.s.runtime.setMode("app");
    expect(await settled(aborted.promise, "runtime switch aborting the held tool", 2000)).toEqual({ resolved: undefined });
    expect(await settled(switching, "runtime switch", 2000)).toMatchObject({ resolved: { owner: expect.any(String) } });
    expect(r.s.runtime.mode()).toBe("app");
    expect(r.app.activeTurns()).toBe(0);
    expect(lease.status()).toEqual({ holder: null, holders: 0, waiting: [] });
    expect(r.events.filter((e) => e.type === "error" || e.type === "done")).toHaveLength(1);
    expectRuntimeChangedEnd(r.events);
    expect(r.store.getThread(r.thread.id).messages.at(-1)).toMatchObject({ role: "assistant", content: "", tools: [{ name: "image", state: "error" }] });
    const seen = r.events.length;
    // The stuck operation finishes in the background: its result is dropped, its job taken back.
    tool.resolve();
    await until(() => cancelled.length === 1);
    // A short observation window checks that no later completion leaks through.
    await sleep(100);
    expect(r.events).toHaveLength(seen);
    expect(r.chats()).toBe(1);
    expect(cancelled).toEqual(["job-late"]);
    await r.done();
  });

  it("a reservation that never ends: the drain bound fails the switch (status error) and keeps the old runtime", async () => {
    const r = await rig({}, { turnDrainMs: 200 });
    const before = r.s.runtime.baseUrl();
    // A turn the switch cannot end early (here a bare reservation nobody ends).
    const stuck = r.s.loader.reserve(MODEL);
    const failed = await settled(r.s.runtime.setMode("app"), "runtime switch");
    expect(failed).toMatchObject({ rejected: expect.objectContaining({ message: expect.stringMatching(/still running/) }) });
    expect(r.s.runtime.mode()).toBe("system");
    expect(r.s.runtime.baseUrl()).toBe(before);
    expect(r.s.runtime.status()).toMatchObject({ state: "error", detail: expect.stringMatching(/still running/) });
    stuck.end();
    await r.done();
  });

  it("R4-07: after a failed switch Settings names the runtime still serving, and choosing the new mode again retries", async () => {
    const r = await rig({}, { turnDrainMs: 200 });
    const stuck = r.s.loader.reserve(MODEL);
    const switches: string[] = [];
    const setMode = r.s.runtime.setMode.bind(r.s.runtime);
    vi.spyOn(r.s.runtime, "setMode").mockImplementation((mode) => {
      switches.push(mode);
      return setMode(mode);
    });
    const choose = (runtimeMode: "app" | "system") => r.s.handlers["settings.update"]!({ runtimeMode }, { clientId: 1 });
    expect(choose("app")).toMatchObject({ runtimeMode: "app" });
    await until(() => r.s.runtime.status().state === "error");
    expect(r.s.runtime.status()).toMatchObject({ state: "error", detail: expect.stringMatching(/still running/) });
    await sleep(20);
    expect(r.s.runtime.mode()).toBe("system");
    expect(r.s.handlers["settings.get"]!({}, { clientId: 1 })).toMatchObject({ runtimeMode: "system" });
    expect(r.s.settingsFrames).toEqual([
      { value: expect.objectContaining({ runtimeMode: "app" }), changes: [{ scope: "settings", kind: "snapshot", rev: 1 }] },
      { value: expect.objectContaining({ runtimeMode: "system" }), changes: [{ scope: "settings", kind: "snapshot", rev: 2 }] },
    ]);
    // R5-04: putting Settings back schedules no switch.
    expect(switches).toEqual(["app"]);
    stuck.end();
    choose("app");
    await until(() => r.s.runtime.mode() === "app");
    expect(r.s.runtime.mode()).toBe("app");
    await r.done();
  });

  it("R5-04: only the newest choice reconciles; an older failed switch neither rolls Settings back nor schedules another switch", async () => {
    const r = await rig({}, { turnDrainMs: 300 });
    const stuck = r.s.loader.reserve(MODEL);
    const switches: string[] = [];
    let first: Promise<unknown> | undefined;
    const setMode = r.s.runtime.setMode.bind(r.s.runtime);
    vi.spyOn(r.s.runtime, "setMode").mockImplementation((mode) => {
      switches.push(mode);
      const switching = setMode(mode);
      // The stuck turn ends once the first switch has failed on it, so the later ones can drain.
      if (switches.length === 1) first = switching.catch((e: unknown) => { stuck.end(); return e; });
      return switching;
    });
    const choose = (runtimeMode: "app" | "system") => r.s.handlers["settings.update"]!({ runtimeMode }, { clientId: 1 });
    choose("app");
    // While the first switch drains: system, then app again.
    choose("system");
    choose("app");
    expect(await settled(first!, "first runtime switch")).toMatchObject({ resolved: { message: expect.stringMatching(/still running/) } });
    await until(() => r.s.runtime.mode() === "app");
    await sleep(100);
    expect(r.s.runtime.mode()).toBe("app");
    expect(r.s.handlers["settings.get"]!({}, { clientId: 1 })).toMatchObject({ runtimeMode: "app" });
    expect(switches).toEqual(["app", "system", "app"]);
    await r.done();
  });
});

describe("R3-02: a switch saves the reply streamed so far", () => {
  // "Marked stopped" is the terminal event's code; the saved message stores no stopped marker.
  it("text and thinking already sent are saved, marked stopped, with one runtime-changed event", async () => {
    const streaming = signalled();
    const r = await rig({
      "POST /api/chat": (_b, res) => {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(line({ model: MODEL, message: { role: "assistant", content: "", thinking: "Let me see. " }, done: false }));
        res.write(line({ model: MODEL, message: { role: "assistant", content: "Already " }, done: false }));
        res.write(line({ model: MODEL, message: { role: "assistant", content: "streamed" }, done: false }));
        streaming.resolve();
        // Never a done line: the reply is mid-stream when the switch lands.
        return new Promise<void>(() => undefined);
      },
    });
    await r.app.handlers["chat.send"]({ threadId: r.thread.id, content: "hello", model: MODEL, numCtx: 16384 }, { clientId: 1 });
    expect(await settled(streaming.promise, "stream readiness")).toEqual({ resolved: undefined });
    await until(() => r.events.filter((e) => e.type === "delta").length >= 2);
    const sent = r.events.filter((e) => e.type === "delta").map((e) => e.text).join("");
    expect(sent).toBe("Already streamed");
    await r.s.runtime.setMode("app");
    expect(r.app.activeTurns()).toBe(0);
    expect(r.events.filter((e) => e.type === "error" || e.type === "done")).toHaveLength(1);
    expectRuntimeChangedEnd(r.events);
    const messages = r.store.getThread(r.thread.id).messages;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[1]).toMatchObject({ content: sent, thinking: "Let me see. ", model: MODEL });
    expect(r.events.at(-1)?.partial).toEqual(messages[1]);
    await r.done();
  });
});

describe("a turn's stream ends once", () => {
  it("R4-02: a switch right after an error event sends no second terminal event", async () => {
    let switchNow: (() => void) | undefined;
    const r = await rig(
      { "POST /api/chat": (_b, res) => void res.writeHead(200, { "content-type": "application/x-ndjson" }).end(line({ error: "model runner crashed" })) },
      { onEvent: (e) => e.type === "error" && switchNow?.() },
    );
    // A switch's first step, landing while the turn handles its error event.
    switchNow = () => r.s.loader.runtimeChanged();
    await r.app.handlers["chat.send"]({ threadId: r.thread.id, content: "hi", model: MODEL, numCtx: 16384 }, { clientId: 1 });
    await until(() => r.app.activeTurns() <= 0);
    expect(r.app.activeTurns()).toBe(0);
    expect(r.events.filter((e) => e.type === "error" || e.type === "done")).toMatchObject([{ type: "error", code: "stream-error" }]);
    r.s.loader.runtimeSettled();
    await r.done();
  });

  it("R4-03: a done line on a body that stays open: the turn closes the connection", async () => {
    const closed = signalled();
    const r = await rig({
      "POST /api/chat": (_b, res) => {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(line({ model: MODEL, message: { role: "assistant", content: "hi" }, done: false }) + line({ model: MODEL, message: { role: "assistant", content: "" }, done: true, done_reason: "stop" }));
        res.on("close", () => closed.resolve());
        return new Promise<void>(() => undefined);
      },
    });
    await r.app.handlers["chat.send"]({ threadId: r.thread.id, content: "hi", model: MODEL, numCtx: 16384 }, { clientId: 1 });
    await until(() => r.app.activeTurns() <= 0);
    expect(r.events.filter((e) => e.type === "error" || e.type === "done")).toMatchObject([{ type: "done" }]);
    expect(await settled(closed.promise, "HTTP request socket closure")).toEqual({ resolved: undefined });
    await r.done();
  });
});

describe("R2-02: chat.send's ComfyUI reclaim ends with the turn", () => {
  /**
   * Little free VRAM, so a cold MODEL spills unless chat.send reclaims the idle app-owned ComfyUI
   * (MainPID 4242, listed holding 8000 MiB) first.
   */
  const tight = {
    ...fit,
    runNvidiaSmi: async (args: readonly string[]) => (args[0]?.startsWith("--query-gpu") ? "16303, 15303, 1000\n" : "4242, /usr/bin/python3 main.py --port 8188, 8000\n"),
  };
  const cold: Record<string, Route> = { "GET /api/ps": (_b, res) => json(res, 200, { models: [] }) };

  it("the reclaim's fit: an /api/show that never answers ends at shutdown", async () => {
    const asked = signalled();
    const lease = createGpuLease();
    const comfy = await ownedIdleComfy(lease, work);
    const r = await rig(
      {
        ...cold,
        "POST /api/show": () => {
          asked.resolve();
          return new Promise<void>(() => undefined);
        },
      },
      { image: comfy.image, lease, fit: tight },
    );
    const send = Promise.resolve(r.app.handlers["chat.send"]({ threadId: r.thread.id, content: "hi", model: MODEL, numCtx: 16384 }, { clientId: 1 })).catch((e: unknown) => e);
    expect(await settled(asked.promise, "held request readiness")).toEqual({ resolved: undefined });
    expect(await settled(r.app.shutdown(), "application shutdown")).toEqual({ resolved: undefined });
    expect(await send).toMatchObject({ code: "cancelled" });
    expect(r.app.activeTurns()).toBe(0);
    expect(comfy.stops()).toBe(0);
    expect(lease.status()).toEqual({ holder: null, holders: 0, waiting: [] });
    await r.done();
    comfy.close();
  });

  it("the reclaim's GPU claim: waiting behind another chat claim ends at shutdown, and the cancelled reclaim never stops ComfyUI", async () => {
    const lease = createGpuLease();
    const comfy = await ownedIdleComfy(lease, work);
    const r = await rig(cold, { image: comfy.image, lease, fit: tight });
    const other = await lease.acquire("chat");
    const send = Promise.resolve(r.app.handlers["chat.send"]({ threadId: r.thread.id, content: "hi", model: MODEL, numCtx: 16384 }, { clientId: 1 })).catch((e: unknown) => e);
    await until(() => lease.status().waiting.length !== 0);
    expect(lease.status().waiting).toEqual(["image"]);
    expect(await settled(r.app.shutdown(), "application shutdown")).toEqual({ resolved: undefined });
    expect(await send).toMatchObject({ code: "cancelled" });
    expect(r.app.activeTurns()).toBe(0);
    expect(lease.status()).toMatchObject({ holders: 1, waiting: [] });
    other();
    await sleep(50);
    expect(comfy.stops()).toBe(0);
    expect(lease.status()).toEqual({ holder: null, holders: 0, waiting: [] });
    await r.done();
    comfy.close();
  });

  it("the reclaim holding its claim, in a held service.inspect(): a switch ends the turn and the image claim with it", async () => {
    const lease = createGpuLease();
    const comfy = await ownedIdleComfy(lease, work);
    const r = await rig(cold, { image: comfy.image, lease, fit: tight });
    const inspect = comfy.hold("inspect");
    const send = Promise.resolve(r.app.handlers["chat.send"]({ threadId: r.thread.id, content: "hi", model: MODEL, numCtx: 16384 }, { clientId: 1 })).catch((e: unknown) => e);
    expect(await settled(inspect.asked, "ComfyUI inspection readiness")).toEqual({ resolved: undefined });
    expect(lease.status()).toMatchObject({ holder: "image" });
    const switched = r.s.runtime.setMode("app");
    expect(await settled(send, "chat send admission")).toMatchObject({ resolved: { code: "runtime-changed" } });
    expect(await settled(r.s.loader.turnsEnded(), "model turns to drain")).toEqual({ resolved: undefined });
    expect(lease.status()).toEqual({ holder: null, holders: 0, waiting: [] });
    await switched;
    inspect.release();
    await sleep(20);
    expect(comfy.stops()).toBe(0);
    await r.done();
    comfy.close();
  });

  it("a ComfyUI stop already begun: the turn ends when it does, and a stop past the drain bound fails the switch", async () => {
    const lease = createGpuLease();
    const comfy = await ownedIdleComfy(lease, work);
    const r = await rig(cold, { image: comfy.image, lease, fit: tight, turnDrainMs: 200 });
    const stop = comfy.hold("stop");
    const send = Promise.resolve(r.app.handlers["chat.send"]({ threadId: r.thread.id, content: "hi", model: MODEL, numCtx: 16384 }, { clientId: 1 })).catch((e: unknown) => e);
    expect(await settled(stop.asked, "ComfyUI stop readiness")).toEqual({ resolved: undefined });
    expect(await settled(r.s.runtime.setMode("app"), "runtime switch")).toMatchObject({ rejected: expect.objectContaining({ message: expect.stringMatching(/still running/) }) });
    expect(r.s.runtime.mode()).toBe("system");
    expect(lease.status()).toMatchObject({ holder: "image" });
    stop.release();
    expect(await send).toMatchObject({ code: "runtime-changed" });
    expect(comfy.stops()).toBe(1);
    expect(lease.status()).toEqual({ holder: null, holders: 0, waiting: [] });
    await r.done();
    comfy.close();
  });
});

describe("a load that needs a busy model's GPU: turns.blocking and chat.send stopOthers", () => {
  const Y = "gemma3:12b";
  const X_VRAM = 9_000_000_000;
  /** 1000 MiB free beside X: Y (6.6 GB) does not fit beside X, and fits in what X holds. */
  const tight = { ...fit, runNvidiaSmi: smi(1000) };
  /** Plenty free: Y fits beside X. */
  const roomy = { ...fit, runNvidiaSmi: smi(15000) };
  const ndjson = { "content-type": "application/x-ndjson" };
  const ctx = { clientId: 1 };

  /**
   * X (MODEL) resident at 16k. Each X reply streams "X so far" and stays open until its connection
   * closes; Y's request waits for every one, as Ollama queues a load that needs a busy model's
   * memory. With `idle`, that model is resident too, and Y loads at once in what it held.
   */
  function twoModels(xVram = X_VRAM, idle?: { name: string; vram: number }) {
    const xStreaming = signalled();
    const xClosed = signalled();
    const xOpen = new Set<Promise<void>>();
    const routes: Record<string, Route> = {
      "GET /api/tags": (_b, res) =>
        json(res, 200, {
          models: [MODEL, Y, ...(idle ? [idle.name] : [])].map((name) => ({ name, size: 6_600_000_000, digest: name, modified_at: "2026-11-01T00:00:00Z" })),
        }),
      "GET /api/ps": (_b, res) => json(res, 200, { models: [entry(MODEL, xVram), ...(idle ? [entry(idle.name, idle.vram)] : [])] }),
      "POST /api/chat": async (b, res) => {
        const { model } = b as { model: string };
        res.writeHead(200, ndjson);
        if (model === MODEL) {
          const closed = new Promise<void>((resolve) => res.on("close", () => resolve()));
          xOpen.add(closed);
          res.write(line({ model, message: { role: "assistant", content: "X so far" }, done: false }));
          xStreaming.resolve();
          await closed;
          xOpen.delete(closed);
          xClosed.resolve();
          return;
        }
        if (idle === undefined) while (xOpen.size > 0) await Promise.all(xOpen);
        res.end(line({ model, message: { role: "assistant", content: "Y here" }, done: false }) + line({ model, message: { role: "assistant", content: "" }, done: true, done_reason: "stop" }));
      },
    };
    return { routes, xStreaming, xClosed };
  }

  async function withX(fitDeps: AppDeps["fit"], options: RigOptions = {}, m = twoModels()) {
    const r = await rig(m.routes, { ...options, fit: fitDeps });
    const xThread = r.store.createThread({ title: "Long answer" });
    const x = await r.app.handlers["chat.send"]({ threadId: xThread.id, content: "write a lot", model: MODEL, numCtx: 16384 }, ctx);
    expect(await settled(m.xStreaming.promise, "stream readiness")).toEqual({ resolved: undefined });
    await until(() => r.events.some((e) => e.turnId === x.turnId && e.type === "delta"));
    const of = (turnId: string) => r.events.filter((e) => e.turnId === turnId);
    const terminal = (turnId: string) => of(turnId).filter((e) => e.type === "error" || e.type === "done");
    return { ...m, r, xThread, x, of, terminal };
  }

  it("stopOthers: X's turn ends now (partial saved, preempted, names Y) and Y's turn reaches its first token", async () => {
    const t = await withX(tight);
    const y = await t.r.app.handlers["chat.send"]({ threadId: t.r.thread.id, content: "hi", model: Y, numCtx: 16384, stopOthers: true }, ctx);
    await until(() => t.of(y.turnId).some((e) => e.type === "delta"));
    expect(t.of(y.turnId).find((e) => e.type === "delta")).toMatchObject({ text: "Y here" });
    const xEnd = t.terminal(t.x.turnId);
    expect(xEnd).toHaveLength(1);
    expect(xEnd[0]).toMatchObject({ type: "error", code: "preempted", neededBy: Y, partial: { content: "X so far", model: MODEL } });
    expect(xEnd[0]?.message).toContain(Y);
    expect(t.r.events.indexOf(xEnd[0]!)).toBeLessThan(t.r.events.findIndex((e) => e.turnId === y.turnId && e.type === "delta"));
    expect(t.r.store.getThread(t.xThread.id).messages.map((m) => [m.role, m.content])).toEqual([["user", "write a lot"], ["assistant", "X so far"]]);
    await until(() => t.terminal(y.turnId).length !== 0);
    expect(t.terminal(y.turnId)).toMatchObject([{ type: "done" }]);
    await t.r.done();
  });

  it("without stopOthers: turns.blocking names X (and loads nothing); Y waits until X ends", async () => {
    const t = await withX(tight);
    const generates = () => t.r.old.requests.filter((q) => q.path === "/api/generate").length;
    expect(await t.r.app.handlers["turns.blocking"]!({ model: Y, numCtx: 16384 }, ctx)).toEqual([{ threadId: t.xThread.id, title: "Long answer", model: MODEL, turnId: t.x.turnId }]);
    expect(generates()).toBe(0);
    const y = await t.r.app.handlers["chat.send"]({ threadId: t.r.thread.id, content: "hi", model: Y, numCtx: 16384 }, ctx);
    await sleep(300);
    expect(t.terminal(t.x.turnId)).toEqual([]);
    expect(t.of(y.turnId).filter((e) => e.type === "delta")).toEqual([]);
    t.r.app.handlers["chat.cancel"]({ turnId: t.x.turnId }, ctx);
    await until(() => t.of(y.turnId).some((e) => e.type === "delta"));
    expect(t.terminal(t.x.turnId)).toMatchObject([{ type: "error", code: "cancelled" }]);
    expect(t.of(y.turnId).find((e) => e.type === "delta")).toMatchObject({ text: "Y here" });
    await t.r.done();
  });

  it("CFS-07, askFirst: a blocker comes back in the refusal, X keeps running and nothing is saved", async () => {
    const t = await withX(tight);
    const send = t.r.app.handlers["chat.send"]({ threadId: t.r.thread.id, content: "hi", model: Y, numCtx: 16384, askFirst: true }, ctx);
    const sent = await settled(Promise.resolve(send), "chat send admission");
    expect(sent).toMatchObject({ rejected: { code: "would-stop", blocking: [{ threadId: t.xThread.id, title: "Long answer", model: MODEL }] } });
    expect(t.terminal(t.x.turnId)).toEqual([]);
    expect(t.r.store.getThread(t.r.thread.id).messages).toEqual([]);
    t.r.app.handlers["chat.cancel"]({ turnId: t.x.turnId }, ctx);
    await t.r.done();
  });

  it("CFT-04, stopTurns: the turn the person agreed to is stopped and Y starts", async () => {
    const t = await withX(tight);
    const y = await t.r.app.handlers["chat.send"]({ threadId: t.r.thread.id, content: "hi", model: Y, numCtx: 16384, stopOthers: true, stopTurns: [t.x.turnId] }, ctx);
    await until(() => t.of(y.turnId).some((e) => e.type === "delta"));
    expect(t.terminal(t.x.turnId)).toMatchObject([{ type: "error", code: "preempted", neededBy: Y }]);
    expect(t.of(y.turnId).find((e) => e.type === "delta")).toMatchObject({ text: "Y here" });
    await t.r.done();
  });

  it("CFT-04, stopTurns: a turn nobody agreed to is named and left running, and nothing is saved", async () => {
    const t = await withX(tight);
    const send = t.r.app.handlers["chat.send"]({ threadId: t.r.thread.id, content: "hi", model: Y, numCtx: 16384, stopOthers: true, stopTurns: ["a-turn-that-has-ended"] }, ctx);
    const sent = await settled(Promise.resolve(send), "chat send admission");
    expect(sent).toMatchObject({ rejected: { code: "would-stop", blocking: [{ threadId: t.xThread.id, title: "Long answer", model: MODEL, turnId: t.x.turnId }] } });
    expect(t.terminal(t.x.turnId)).toEqual([]);
    expect(t.r.store.getThread(t.r.thread.id).messages).toEqual([]);
    t.r.app.handlers["chat.cancel"]({ turnId: t.x.turnId }, ctx);
    await t.r.done();
  });

  it("CFT-04, stopTurns: agreed to one of two turns in the way, nothing is stopped and both are named, so the next yes covers both", async () => {
    const t = await withX(tight);
    const second = t.r.store.createThread({ title: "Second answer" });
    const x2 = await t.r.app.handlers["chat.send"]({ threadId: second.id, content: "more", model: MODEL, numCtx: 16384 }, ctx);
    await until(() => t.of(x2.turnId).some((e) => e.type === "delta"));
    const send = t.r.app.handlers["chat.send"]({ threadId: t.r.thread.id, content: "hi", model: Y, numCtx: 16384, stopOthers: true, stopTurns: [t.x.turnId] }, ctx);
    const sent = await settled(Promise.resolve(send), "chat send admission");
    expect(sent).toMatchObject({ rejected: { code: "would-stop" } });
    const named = ((sent as { rejected: { blocking: { turnId: string }[] } }).rejected.blocking).map((b) => b.turnId);
    expect(named.toSorted()).toEqual([t.x.turnId, x2.turnId].toSorted());
    expect(t.terminal(t.x.turnId)).toEqual([]);
    expect(t.terminal(x2.turnId)).toEqual([]);
    t.r.app.handlers["chat.cancel"]({ turnId: t.x.turnId }, ctx);
    t.r.app.handlers["chat.cancel"]({ turnId: x2.turnId }, ctx);
    await t.r.done();
  });

  it("CFS-07, askFirst: a cold X holding the load gate is named at once, not waited behind", async () => {
    const lease = createGpuLease();
    let xResident = false;
    const xAsked = signalled();
    const r = await rig(
      {
        "GET /api/tags": (_b, res) => json(res, 200, { models: [MODEL, Y].map((name) => ({ name, size: 6_600_000_000, digest: name, modified_at: "2026-11-01T00:00:00Z" })) }),
        "GET /api/ps": (_b, res) => json(res, 200, { models: xResident ? [entry(MODEL, X_VRAM)] : [] }),
        "POST /api/chat": async (_b, res) => {
          // Loading, or reading the prompt: resident, and no token yet.
          res.writeHead(200, ndjson);
          xResident = true;
          xAsked.resolve();
          await new Promise<void>((resolve) => res.on("close", () => resolve()));
        },
      },
      { fit: tight, lease },
    );
    const x = await r.app.handlers["chat.send"]({ threadId: r.store.createThread({}).id, content: "write a lot", model: MODEL, numCtx: 16384 }, ctx);
    expect(await settled(xAsked.promise, "held request readiness")).toEqual({ resolved: undefined });
    const sent = await settled(Promise.resolve(r.app.handlers["chat.send"]({ threadId: r.thread.id, content: "hi", model: Y, numCtx: 16384, askFirst: true }, ctx)), "chat send admission");
    expect(sent).toMatchObject({ rejected: { code: "would-stop", blocking: [{ model: MODEL }] } });
    r.app.handlers["chat.cancel"]({ turnId: x.turnId }, ctx);
    await r.done();
  });

  it("CFS-07, askFirst: with room beside X the turn starts as usual", async () => {
    const t = await withX(roomy);
    const y = await t.r.app.handlers["chat.send"]({ threadId: t.r.thread.id, content: "hi", model: Y, numCtx: 16384, askFirst: true }, ctx);
    expect(y.turnId).toEqual(expect.any(String));
    expect(t.terminal(t.x.turnId)).toEqual([]);
    t.r.app.handlers["chat.cancel"]({ turnId: t.x.turnId }, ctx);
    await t.r.done();
  });

  it("CFS-07, askFirst: stopOthers wins, so a confirmed retry is never refused", async () => {
    const t = await withX(tight);
    const y = await t.r.app.handlers["chat.send"]({ threadId: t.r.thread.id, content: "hi", model: Y, numCtx: 16384, stopOthers: true, askFirst: true }, ctx);
    await until(() => t.terminal(y.turnId).length !== 0);
    expect(t.terminal(t.x.turnId)).toMatchObject([{ type: "error", code: "preempted" }]);
    await t.r.done();
  });

  it("R4-01: with an idle app-owned ComfyUI too, stopOthers ends X before any image claim, then measures again", async () => {
    const lease = createGpuLease();
    const comfy = await ownedIdleComfy(lease, work);
    const t = await withX(tight, { image: comfy.image, lease });
    const send = t.r.app.handlers["chat.send"]({ threadId: t.r.thread.id, content: "hi", model: Y, numCtx: 16384, stopOthers: true }, ctx);
    const sent = await settled(Promise.resolve(send), "chat send admission");
    expect(sent).toMatchObject({ resolved: { turnId: expect.any(String) } });
    const y = (sent as { resolved: { turnId: string } }).resolved;
    await until(() => t.terminal(y.turnId).length !== 0);
    expect(t.terminal(t.x.turnId)).toMatchObject([{ type: "error", code: "preempted", neededBy: Y }]);
    expect(t.of(y.turnId).find((e) => e.type === "delta")).toMatchObject({ text: "Y here" });
    // X's memory, idle once its turn ended, was enough: ComfyUI kept running and nothing waits on the lease.
    expect(comfy.stops()).toBe(0);
    expect(lease.status().waiting).toEqual([]);
    await t.r.done();
    comfy.close();
  });

  it("R4-05: a second X turn sent while Y's plan reads the GPU is stopped too before Y loads", async () => {
    let pause: Promise<void> | undefined;
    const paused = signalled();
    const resume = signalled();
    const runNvidiaSmi = async (args: readonly string[]) => {
      const p = pause;
      pause = undefined;
      if (p) {
        paused.resolve();
        await p;
      }
      return smi(1000)(args);
    };
    const t = await withX({ ...fit, runNvidiaSmi });
    pause = resume.promise;
    const y = Promise.resolve(t.r.app.handlers["chat.send"]({ threadId: t.r.thread.id, content: "hi", model: Y, numCtx: 16384, stopOthers: true }, ctx));
    expect(await settled(paused.promise, "held request readiness")).toEqual({ resolved: undefined });
    const x2Thread = t.r.store.createThread({});
    const x2 = Promise.resolve(t.r.app.handlers["chat.send"]({ threadId: x2Thread.id, content: "more", model: MODEL, numCtx: 16384 }, ctx));
    // Unless something holds it back, the second X turn is streaming before Y's plan goes on.
    await until(() => t.r.events.filter((e) => e.text === "X so far").length >= 2);
    resume.resolve();
    const yTurn = await y;
    await until(() => t.of(yTurn.turnId).some((e) => e.type === "delta"));
    expect(t.of(yTurn.turnId).find((e) => e.type === "delta")).toMatchObject({ text: "Y here" });
    expect(t.terminal(t.x.turnId)).toMatchObject([{ type: "error", code: "preempted" }]);
    const x2Turn = await x2;
    // Y's plan reads the GPU before the load gate (R5-01), so the second X turn was admitted and
    // streaming meanwhile: the next plan stops it too, before Y's load.
    expect(t.terminal(x2Turn.turnId)).toMatchObject([{ type: "error", code: "preempted", neededBy: Y }]);
    expect(t.r.events.indexOf(t.terminal(x2Turn.turnId)[0]!)).toBeLessThan(t.r.events.findIndex((e) => e.turnId === yTurn.turnId && e.type === "delta"));
    await t.r.done();
  });

  it("R4-05: two cold sends at once, each with stopOthers: the second one admitted stops the first", async () => {
    const Z = "llama3.1:8b";
    const loaded = new Set<string>();
    const streaming = new Map<string, Promise<void>>();
    const r = await rig(
      {
        "GET /api/tags": (_b, res) => json(res, 200, { models: [Y, Z].map((name) => ({ name, size: 6_600_000_000, digest: name, modified_at: "2026-11-01T00:00:00Z" })) }),
        "GET /api/ps": (_b, res) => json(res, 200, { models: [...loaded].map((name) => entry(name, X_VRAM)) }),
        // Each model loads once nothing else streams, then streams until its connection closes.
        "POST /api/chat": async (b, res) => {
          const { model } = b as { model: string };
          res.writeHead(200, ndjson);
          while ([...streaming.keys()].some((m) => m !== model)) await Promise.all([...streaming].filter(([m]) => m !== model).map(([, p]) => p));
          loaded.add(model);
          const closed = new Promise<void>((resolve) => res.on("close", () => resolve()));
          streaming.set(model, closed);
          res.write(line({ model, message: { role: "assistant", content: `${model} here` }, done: false }));
          await closed;
          streaming.delete(model);
        },
      },
      { fit: tight },
    );
    const sendOn = async (model: string) => (await r.app.handlers["chat.send"]({ threadId: r.store.createThread({}).id, content: "hi", model, numCtx: 16384, stopOthers: true }, ctx)).turnId;
    const ids = await Promise.all([sendOn(Y), sendOn(Z)]);
    const delta = (id: string) => r.events.some((e) => e.turnId === id && e.type === "delta");
    await until(() => ids.every(delta));
    expect(ids.filter(delta)).toHaveLength(2);
    expect(r.events.filter((e) => e.type === "error" || e.type === "done")).toMatchObject([{ type: "error", code: "preempted" }]);
    expect(r.app.activeTurns()).toBe(1);
    await r.done();
  });

  it("R4-04: ~1 GB free, busy X at 4 GB, idle Z at 9 GB: Y loads in Z's memory and X keeps streaming", async () => {
    const t = await withX(tight, {}, twoModels(4e9, { name: "llama3.1:8b", vram: 9e9 }));
    expect(await t.r.app.handlers["turns.blocking"]!({ model: Y, numCtx: 16384 }, ctx)).toEqual([]);
    const y = await t.r.app.handlers["chat.send"]({ threadId: t.r.thread.id, content: "hi", model: Y, numCtx: 16384, stopOthers: true }, ctx);
    await until(() => t.terminal(y.turnId).length !== 0);
    expect(t.of(y.turnId).find((e) => e.type === "delta")).toMatchObject({ text: "Y here" });
    expect(t.terminal(y.turnId)).toMatchObject([{ type: "done" }]);
    expect(t.terminal(t.x.turnId)).toEqual([]);
    expect(t.r.app.activeTurns()).toBe(1);
    await t.r.done();
  });

  it("R5-01: a cold X in /api/ps that never sends a token still holds the load gate; Y's stopOthers stops it and Y is admitted", async () => {
    const lease = createGpuLease();
    let xResident = false;
    const xAsked = signalled();
    const xOpen = new Set<Promise<void>>();
    let atYChat: { xEnded: boolean; holders: number } | undefined;
    const r = await rig(
      {
        "GET /api/tags": (_b, res) => json(res, 200, { models: [MODEL, Y].map((name) => ({ name, size: 6_600_000_000, digest: name, modified_at: "2026-11-01T00:00:00Z" })) }),
        "GET /api/ps": (_b, res) => json(res, 200, { models: xResident ? [entry(MODEL, X_VRAM)] : [] }),
        "POST /api/chat": async (b, res) => {
          const { model } = b as { model: string };
          res.writeHead(200, ndjson);
          if (model === MODEL) {
            // Loading, or reading the prompt: resident, and no token yet.
            xResident = true;
            const closed = new Promise<void>((resolve) => res.on("close", () => resolve()));
            xOpen.add(closed);
            xAsked.resolve();
            await closed;
            xOpen.delete(closed);
            return;
          }
          while (xOpen.size > 0) await Promise.all(xOpen);
          atYChat = { xEnded: r.events.some((e) => e.turnId === x.turnId && (e.type === "error" || e.type === "done")), holders: lease.status().holders };
          res.end(line({ model, message: { role: "assistant", content: "Y here" }, done: false }) + line({ model, message: { role: "assistant", content: "" }, done: true, done_reason: "stop" }));
        },
      },
      { fit: tight, lease },
    );
    const x = await r.app.handlers["chat.send"]({ threadId: r.store.createThread({}).id, content: "write a lot", model: MODEL, numCtx: 16384 }, ctx);
    expect(await settled(xAsked.promise, "held request readiness")).toEqual({ resolved: undefined });
    const sent = await settled(Promise.resolve(r.app.handlers["chat.send"]({ threadId: r.thread.id, content: "hi", model: Y, numCtx: 16384, stopOthers: true }, ctx)), "chat send admission");
    expect(sent).toMatchObject({ resolved: { turnId: expect.any(String) } });
    const y = (sent as { resolved: { turnId: string } }).resolved;
    const terminal = (turnId: string) => r.events.filter((e) => e.turnId === turnId && (e.type === "error" || e.type === "done"));
    await until(() => terminal(y.turnId).length !== 0);
    expect(terminal(x.turnId)).toMatchObject([{ type: "error", code: "preempted", neededBy: Y }]);
    expect(r.events.find((e) => e.turnId === y.turnId && e.type === "delta")).toMatchObject({ text: "Y here" });
    expect(terminal(y.turnId)).toMatchObject([{ type: "done" }]);
    // X's claim went before Y's request reached Ollama; Y's goes at its end.
    expect(atYChat).toEqual({ xEnded: true, holders: 1 });
    await until(() => lease.status().holders <= 0);
    expect(lease.status()).toEqual({ holder: null, holders: 0, waiting: [] });
    await r.done();
  });

  it("R5-02: Y needs X's memory and ComfyUI's together: X is stopped and drained, then ComfyUI, then Y is admitted", async () => {
    const lease = createGpuLease();
    const comfy = await ownedIdleComfy(lease, work);
    // Y needs about 7830 MiB plus the 512 MiB margin: 1000 free + X's 1907 + ComfyUI's 6000, and neither alone is enough.
    const t = await withX(withComfyToo(comfy, 6000), { image: comfy.image, lease }, twoModels(2e9));
    const sent = await settled(Promise.resolve(t.r.app.handlers["chat.send"]({ threadId: t.r.thread.id, content: "hi", model: Y, numCtx: 16384, stopOthers: true }, ctx)), "chat send admission");
    expect(sent).toMatchObject({ resolved: { turnId: expect.any(String) } });
    const y = (sent as { resolved: { turnId: string } }).resolved;
    await until(() => t.terminal(y.turnId).length !== 0);
    expect(t.terminal(t.x.turnId)).toMatchObject([{ type: "error", code: "preempted", neededBy: Y }]);
    expect(comfy.stops()).toBe(1);
    expect(t.of(y.turnId).find((e) => e.type === "delta")).toMatchObject({ text: "Y here" });
    expect(t.terminal(y.turnId)).toMatchObject([{ type: "done" }]);
    await t.r.done();
    comfy.close();
  });

  it("R5-02: when even X's memory and ComfyUI's together are short, the send refuses at once and stops nothing", async () => {
    const lease = createGpuLease();
    const comfy = await ownedIdleComfy(lease, work);
    const t = await withX(withComfyToo(comfy, 1000), { image: comfy.image, lease }, twoModels(2e9));
    const sent = await settled(Promise.resolve(t.r.app.handlers["chat.send"]({ threadId: t.r.thread.id, content: "hi", model: Y, numCtx: 16384, stopOthers: true }, ctx)), "chat send admission");
    expect(sent).toMatchObject({ rejected: { code: "wont-fit" } });
    expect(t.terminal(t.x.turnId)).toEqual([]);
    expect(comfy.stops()).toBe(0);
    expect(lease.status()).toMatchObject({ holder: "chat", holders: 1, waiting: [] });
    await t.r.done();
    comfy.close();
  });

  it.each([{ stopOthers: true }, { askFirst: true }] as const)("a cold X holding the load gate: impossible Y refuses before waiting (%j)", async (consent) => {
    const lease = createGpuLease();
    const xAsked = signalled();
    let yAsked = false;
    let xResident = false;
    const r = await rig(
      {
        "GET /api/tags": (_b, res) => json(res, 200, { models: [MODEL, Y].map((name) => ({ name, size: 6_600_000_000, digest: name, modified_at: "2026-11-01T00:00:00Z" })) }),
        "GET /api/ps": (_b, res) => json(res, 200, { models: xResident ? [entry(MODEL, 2e9)] : [] }),
        "POST /api/chat": async (b, res) => {
          res.writeHead(200, ndjson);
          if ((b as { model: string }).model !== MODEL) yAsked = true;
          xResident = true;
          xAsked.resolve();
          // Cold, and no token: X holds the load gate until it ends.
          await new Promise<void>((resolve) => res.on("close", () => resolve()));
        },
      },
      // 15000 MiB free until X loads, 1000 beside it: X fits, Y does not even in X's 2 GB.
      { fit: { runNvidiaSmi: (args) => (xResident ? smi(1000) : smi(15000))(args), readMeminfo: async () => "MemAvailable: 1000000 kB\n" }, lease },
    );
    const x = await r.app.handlers["chat.send"]({ threadId: r.store.createThread({}).id, content: "write a lot", model: MODEL, numCtx: 16384 }, ctx);
    expect(await settled(xAsked.promise, "held request readiness")).toEqual({ resolved: undefined });
    const sent = await settled(Promise.resolve(r.app.handlers["chat.send"]({ threadId: r.thread.id, content: "hi", model: Y, numCtx: 16384, ...consent }, ctx)), "chat send admission");
    expect(sent).toMatchObject({ rejected: { code: "wont-fit" } });
    expect(r.events.filter((e) => e.turnId === x.turnId && (e.type === "error" || e.type === "done"))).toEqual([]);
    expect(yAsked).toBe(false);
    expect(lease.status()).toMatchObject({ holder: "chat", holders: 1, waiting: [] });
    await r.done();
  });

  it("R5-03: ~1 GB free, an idle 9 GB model, RAM under its margin: the fit table, a preload and chat.send give one verdict", async () => {
    const Z = "llama3.1:8b";
    const r = await rig(
      {
        "GET /api/tags": (_b, res) => json(res, 200, { models: [Y, Z].map((name) => ({ name, size: 6_600_000_000, digest: name, modified_at: "2026-11-01T00:00:00Z" })) }),
        "GET /api/ps": (_b, res) => json(res, 200, { models: [entry(Z, 9e9)] }),
        "POST /api/generate": (_b, res) => json(res, 200, { model: Y, response: "", done: true }),
        "POST /api/chat": (_b, res) => {
          res.writeHead(200, ndjson);
          res.end(line({ model: Y, message: { role: "assistant", content: "Y here" }, done: false }) + line({ model: Y, message: { role: "assistant", content: "" }, done: true, done_reason: "stop" }));
        },
      },
      { fit: { runNvidiaSmi: smi(1000), readMeminfo: async () => "MemAvailable: 1000000 kB\n" } },
    );
    const table = await r.app.handlers["fit.table"]({}, ctx);
    expect(table.rows.find((row) => row.model === Y && row.numCtx === 16384)).toMatchObject({ verdict: "fits" });
    expect(await r.s.handlers["models.load"]!({ model: Y, numCtx: 16384 }, ctx)).toMatchObject({ state: "ready" });
    const y = await r.app.handlers["chat.send"]({ threadId: r.thread.id, content: "hi", model: Y, numCtx: 16384 }, ctx);
    await until(() => r.events.some((e) => e.turnId === y.turnId && e.type === "done"));
    expect(r.events.filter((e) => e.turnId === y.turnId).map((e) => e.type)).toEqual(["start", "delta", "done"]);
    await r.done();
  });

  it("turns on the same model, or on a model that fits beside, are never stopped", async () => {
    const t = await withX(roomy);
    expect(await t.r.app.handlers["turns.blocking"]!({ model: Y, numCtx: 16384 }, ctx)).toEqual([]);
    expect(await t.r.app.handlers["turns.blocking"]!({ model: MODEL, numCtx: 16384 }, ctx)).toEqual([]);
    const other = t.r.store.createThread({});
    await t.r.app.handlers["chat.send"]({ threadId: other.id, content: "hi", model: MODEL, numCtx: 16384, stopOthers: true }, ctx);
    await t.r.app.handlers["chat.send"]({ threadId: t.r.thread.id, content: "hi", model: Y, numCtx: 16384, stopOthers: true }, ctx);
    await sleep(200);
    expect(t.terminal(t.x.turnId)).toEqual([]);
    expect(t.r.app.activeTurns()).toBe(3);
    await t.r.done();
  });
});
