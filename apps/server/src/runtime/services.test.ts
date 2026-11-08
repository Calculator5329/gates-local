// createModelServices wired end to end with fakes: a fake `ollama` binary in
// the data dir, fake Ollama HTTP servers, fake nvidia-smi and meminfo. The
// GPU watcher is stopped at once so nothing reads systemd or the real GPU.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
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

async function services(dataDir: string, runtime: Record<string, unknown>, lease?: GpuLease): Promise<ModelServices> {
  const home = path.join(work, "home");
  const s = await createModelServices({
    dataDir,
    push: () => undefined,
    runtime: { home, env: { PATH: "", HOME: home }, systemModelsDirs: [], allowInstall: false, probeTimeoutMs: 500, manifest, ...runtime },
    fit,
    log: () => undefined,
    ...(lease ? { lease } : {}),
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

describe("R2-03: a runtime switch ends every turn reserved against the old runtime", () => {
  const MODEL = "qwen3.5:9b";

  /** A system Ollama with MODEL resident at 16k (the fit is measured, no /api/show), the services and the app around it. */
  async function rig(routes: Record<string, Route>, image?: ImageModule) {
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
    const s = await services(path.join(work, "data"), { appPort: await freePort(), externalBaseUrl: old.baseUrl });
    expect(s.runtime.mode()).toBe("system");
    expect((await s.runtime.ensure()).state).toBe("ready");
    const store = openThreadStore(path.join(work, "threads.sqlite"));
    const events: { type: string; code?: string; message?: string }[] = [];
    const app = createApp({
      store,
      runtime: s.runtime,
      catalog: s.catalog,
      push: (channel, payload) => {
        if (channel === "chat.event") events.push((payload as { event: { type: string } }).event);
      },
      models: { handlers: s.handlers, loader: s.loader },
      fit,
      ...(image ? { image } : {}),
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
      image,
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
});
