// createModelServices wired end to end with fakes: a fake `ollama` binary in
// the data dir, fake Ollama HTTP servers, fake nvidia-smi and meminfo. The
// GPU watcher is stopped at once so nothing reads systemd or the real GPU.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../app.ts";
import { json, startFakeServer, type FakeServer, type Route } from "../fit/fake-http.ts";
import type { ImageModule } from "../image/module.ts";
import { openThreadStore } from "../threads/store.ts";
import { httpGet } from "./http.ts";
import { appModelsDir, installedBinary } from "./paths.ts";
import { createGpuLease, type GpuLease } from "../gpu/lease.ts";
import { createModelServices, type ModelServices } from "./services.ts";
import { freePort, freePortRun, removeDir, tmpDir, writeFakeBinary } from "./test-fakes.ts";
import { ownedIdleComfy } from "./test-image.ts";

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

async function services(dataDir: string, runtime: Record<string, unknown>, lease?: GpuLease, turnDrainMs?: number): Promise<ModelServices> {
  const home = path.join(work, "home");
  const s = await createModelServices({
    dataDir,
    push: () => undefined,
    runtime: { home, env: { PATH: "", HOME: home }, systemModelsDirs: [], allowInstall: false, probeTimeoutMs: 500, manifest, ...runtime },
    fit,
    log: () => undefined,
    ...(lease ? { lease } : {}),
    ...(turnDrainMs === undefined ? {} : { turnDrainMs }),
  });
  s.gpu.stop();
  open.push(s);
  return s;
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
  await new Promise((r) => setTimeout(r, 50));
  healthy = false;
  await s.runtime.discover();
  expect(s.runtime.baseUrl()).toBeUndefined();
  releasePs();
  const r = await loading;
  expect(ollama.requests.some((q) => q.path === "/api/show")).toBe(true);
  expect(r).toMatchObject({ state: "ready" });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A promise and the function that resolves it. */
function signalled(): { promise: Promise<void>; resolve: () => void } {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, resolve: () => release?.() };
}
const settledWithin = <T>(p: Promise<T>, ms: number): Promise<unknown> =>
  Promise.race([p.then((v) => ({ resolved: v }), (e: unknown) => ({ rejected: e })), sleep(ms).then(() => "pending")]);

describe("R2-02: shutdown aborts a preload in its residency read or its fit", () => {
  for (const where of ["/api/ps", "/api/show"] as const) {
    it(`a request to ${where} that never answers ends at close(); loader and image close settle well under main's 2500 ms`, async () => {
      const hungAt = signalled();
      const hung = hungAt.promise;
      const never: Route = () => {
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
      expect(await settledWithin(hung, 1000)).toEqual({ resolved: undefined });
      // main.ts: cancel turns, drain model loads, close image module.
      const started = Date.now();
      const shutdown = (async () => {
        await s.loader.close();
        await comfy.image.close();
      })();
      expect(await settledWithin(shutdown, 1000)).toEqual({ resolved: undefined });
      expect(Date.now() - started).toBeLessThan(1000);
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
    "GET /api/ps": (_b, res) => json(res, 200, { models: [{ name: MODEL, size: 1, size_vram: 1, context_length: 16384 }] }),
    "POST /api/show": (_b, res) => json(res, 200, SHOW),
    ...routes,
  });
  servers.push(old);
  const s = await services(path.join(work, "data"), { appPort: await freePort(), externalBaseUrl: old.baseUrl }, options.lease, options.turnDrainMs);
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
    ...(options.image ? { image: options.image } : {}),
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
    expect(await settledWithin(asked.promise, 1000)).toEqual({ resolved: undefined });
    const switching = r.s.runtime.setMode("app");
    await sleep(50);
    show.resolve();
    await switching;
    for (let i = 0; i < 200 && r.app.activeTurns() > 0; i++) await sleep(5);
    await sleep(50);
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
    await r.app.handlers["chat.send"]({ threadId: r.thread.id, content: "draw a cat", model: MODEL, numCtx: 16384, image: true }, { clientId: 1 });
    expect(await settledWithin(queuedOnce.promise, 1000)).toEqual({ resolved: undefined });
    expect([queued, r.chats()]).toEqual([1, 1]);
    const switching = r.s.runtime.setMode("app");
    await sleep(50);
    tool.resolve();
    await switching;
    for (let i = 0; i < 200 && r.app.activeTurns() > 0; i++) await sleep(5);
    await sleep(50);
    expect(r.chats()).toBe(1);
    expect(r.app.activeTurns()).toBe(0);
    expectRuntimeChangedEnd(r.events);
    expect(r.store.getThread(r.thread.id).messages.map((m) => m.role)).toEqual(["user"]);
    await r.done();
  });

  it("a tool that never lets go: the switch ends the turn now (one runtime-changed, GPU claim released) and completes; the tool's late result is dropped", async () => {
    const tool = signalled();
    const queuedOnce = signalled();
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
      { image, lease },
    );
    await r.app.handlers["chat.send"]({ threadId: r.thread.id, content: "draw a cat", model: MODEL, numCtx: 16384, image: true }, { clientId: 1 });
    expect(await settledWithin(queuedOnce.promise, 1000)).toEqual({ resolved: undefined });
    expect(lease.status().holders).toBe(1);
    const started = Date.now();
    // The tool is still held: the switch must not wait on it (nor time out and go on).
    expect(await settledWithin(r.s.runtime.setMode("app"), 2000)).toMatchObject({ resolved: { owner: expect.any(String) } });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.s.runtime.mode()).toBe("app");
    expect(r.app.activeTurns()).toBe(0);
    expect(lease.status()).toEqual({ holder: null, holders: 0, waiting: [] });
    expect(r.events.filter((e) => e.type === "error" || e.type === "done")).toHaveLength(1);
    expectRuntimeChangedEnd(r.events);
    const seen = r.events.length;
    // The stuck operation finishes in the background: its result is dropped, its job taken back.
    tool.resolve();
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
    const failed = await settledWithin(r.s.runtime.setMode("app"), 2000);
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
    const choose = (runtimeMode: "app" | "system") => r.s.handlers["settings.update"]!({ runtimeMode }, { clientId: 1 });
    expect(choose("app")).toMatchObject({ runtimeMode: "app" });
    for (let i = 0; i < 200 && r.s.runtime.status().state !== "error"; i++) await sleep(5);
    expect(r.s.runtime.status()).toMatchObject({ state: "error", detail: expect.stringMatching(/still running/) });
    await sleep(20);
    expect(r.s.runtime.mode()).toBe("system");
    expect(r.s.handlers["settings.get"]!({}, { clientId: 1 })).toMatchObject({ runtimeMode: "system" });
    stuck.end();
    choose("app");
    for (let i = 0; i < 400 && r.s.runtime.mode() !== "app"; i++) await sleep(5);
    expect(r.s.runtime.mode()).toBe("app");
    await r.done();
  });
});

describe("R3-02: a switch saves the reply streamed so far", () => {
  // TODO(turns-queue): R3-02: "marked stopped" is the event's code only; no stopped marker is stored yet.
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
    expect(await settledWithin(streaming.promise, 1000)).toEqual({ resolved: undefined });
    for (let i = 0; i < 200 && r.events.filter((e) => e.type === "delta").length < 2; i++) await sleep(5);
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
    for (let i = 0; i < 200 && r.app.activeTurns() > 0; i++) await sleep(5);
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
    for (let i = 0; i < 200 && r.app.activeTurns() > 0; i++) await sleep(5);
    expect(r.events.filter((e) => e.type === "error" || e.type === "done")).toMatchObject([{ type: "done" }]);
    expect(await settledWithin(closed.promise, 1000)).toEqual({ resolved: undefined });
    await r.done();
  });
});

describe("R2-02: chat.send's ComfyUI reclaim ends with the turn", () => {
  /** Little free VRAM, so a cold MODEL spills and chat.send reclaims an idle app-owned ComfyUI first. */
  const tight = { ...fit, runNvidiaSmi: async (args: readonly string[]) => (args[0]?.startsWith("--query-gpu") ? "16303, 15303, 1000\n" : "") };
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
    expect(await settledWithin(asked.promise, 1000)).toEqual({ resolved: undefined });
    expect(await settledWithin(r.app.shutdown(), 1000)).toEqual({ resolved: undefined });
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
    for (let i = 0; i < 200 && lease.status().waiting.length === 0; i++) await sleep(5);
    expect(lease.status().waiting).toEqual(["image"]);
    expect(await settledWithin(r.app.shutdown(), 1000)).toEqual({ resolved: undefined });
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
    expect(await settledWithin(inspect.asked, 1000)).toEqual({ resolved: undefined });
    expect(lease.status()).toMatchObject({ holder: "image" });
    const switched = r.s.runtime.setMode("app");
    expect(await send).toMatchObject({ code: "runtime-changed" });
    expect(await settledWithin(r.s.loader.turnsEnded(), 1000)).toEqual({ resolved: undefined });
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
    expect(await settledWithin(stop.asked, 1000)).toEqual({ resolved: undefined });
    expect(await settledWithin(r.s.runtime.setMode("app"), 2000)).toMatchObject({ rejected: expect.objectContaining({ message: expect.stringMatching(/still running/) }) });
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
    expect(await settledWithin(m.xStreaming.promise, 1000)).toEqual({ resolved: undefined });
    for (let i = 0; i < 200 && !r.events.some((e) => e.turnId === x.turnId && e.type === "delta"); i++) await sleep(5);
    const of = (turnId: string) => r.events.filter((e) => e.turnId === turnId);
    const terminal = (turnId: string) => of(turnId).filter((e) => e.type === "error" || e.type === "done");
    return { ...m, r, xThread, x, of, terminal };
  }

  it("stopOthers: X's turn ends now (partial saved, preempted, names Y) and Y's turn reaches its first token", async () => {
    const t = await withX(tight);
    const y = await t.r.app.handlers["chat.send"]({ threadId: t.r.thread.id, content: "hi", model: Y, numCtx: 16384, stopOthers: true }, ctx);
    for (let i = 0; i < 400 && !t.of(y.turnId).some((e) => e.type === "delta"); i++) await sleep(5);
    expect(t.of(y.turnId).find((e) => e.type === "delta")).toMatchObject({ text: "Y here" });
    const xEnd = t.terminal(t.x.turnId);
    expect(xEnd).toHaveLength(1);
    expect(xEnd[0]).toMatchObject({ type: "error", code: "preempted", neededBy: Y, partial: { content: "X so far", model: MODEL } });
    expect(xEnd[0]?.message).toContain(Y);
    expect(t.r.events.indexOf(xEnd[0]!)).toBeLessThan(t.r.events.findIndex((e) => e.turnId === y.turnId && e.type === "delta"));
    expect(t.r.store.getThread(t.xThread.id).messages.map((m) => [m.role, m.content])).toEqual([["user", "write a lot"], ["assistant", "X so far"]]);
    for (let i = 0; i < 200 && t.terminal(y.turnId).length === 0; i++) await sleep(5);
    expect(t.terminal(y.turnId)).toMatchObject([{ type: "done" }]);
    await t.r.done();
  });

  it("without stopOthers: turns.blocking names X (and loads nothing); Y waits until X ends", async () => {
    const t = await withX(tight);
    const generates = () => t.r.old.requests.filter((q) => q.path === "/api/generate").length;
    expect(await t.r.app.handlers["turns.blocking"]!({ model: Y, numCtx: 16384 }, ctx)).toEqual([{ threadId: t.xThread.id, title: "Long answer", model: MODEL }]);
    expect(generates()).toBe(0);
    const y = await t.r.app.handlers["chat.send"]({ threadId: t.r.thread.id, content: "hi", model: Y, numCtx: 16384 }, ctx);
    await sleep(300);
    expect(t.terminal(t.x.turnId)).toEqual([]);
    expect(t.of(y.turnId).filter((e) => e.type === "delta")).toEqual([]);
    t.r.app.handlers["chat.cancel"]({ turnId: t.x.turnId }, ctx);
    for (let i = 0; i < 400 && !t.of(y.turnId).some((e) => e.type === "delta"); i++) await sleep(5);
    expect(t.terminal(t.x.turnId)).toMatchObject([{ type: "error", code: "cancelled" }]);
    expect(t.of(y.turnId).find((e) => e.type === "delta")).toMatchObject({ text: "Y here" });
    await t.r.done();
  });

  it("R4-04: ~1 GB free, busy X at 4 GB, idle Z at 9 GB: Y loads in Z's memory and X keeps streaming", async () => {
    const t = await withX(tight, {}, twoModels(4e9, { name: "llama3.1:8b", vram: 9e9 }));
    expect(await t.r.app.handlers["turns.blocking"]!({ model: Y, numCtx: 16384 }, ctx)).toEqual([]);
    const y = await t.r.app.handlers["chat.send"]({ threadId: t.r.thread.id, content: "hi", model: Y, numCtx: 16384, stopOthers: true }, ctx);
    for (let i = 0; i < 400 && t.terminal(y.turnId).length === 0; i++) await sleep(5);
    expect(t.of(y.turnId).find((e) => e.type === "delta")).toMatchObject({ text: "Y here" });
    expect(t.terminal(y.turnId)).toMatchObject([{ type: "done" }]);
    expect(t.terminal(t.x.turnId)).toEqual([]);
    expect(t.r.app.activeTurns()).toBe(1);
    await t.r.done();
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
