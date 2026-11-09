// app.ts's models deps field in process: a chat turn on a model that is not
// in /api/ps pushes models.load "loading", then "ready" once the reply
// starts, the turn holds its model from chat.send's first line (so
// models.remove sees it), and the module handlers are reachable through
// app.handlers.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Channel, ModelLoad } from "@gates-local/contracts";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createGpuLease, type GpuLease } from "../gpu/lease.ts";
import { json, startFakeServer, type FakeServer, type Route } from "../fit/fake-http.ts";
import { defaultSettings } from "../settings/store.ts";
import { openThreadStore } from "../threads/store.ts";
import { createRuntimeHandlers } from "./handlers.ts";
import { ModelActionError, createModelLoader } from "./load.ts";
import { createModelCatalog, listLoaded } from "./models.ts";
import { createPullManager } from "./pull.ts";
import { createOllamaRuntime } from "./runtime.ts";
import { freePort } from "./test-fakes.ts";

const MODEL = "qwen3.5:9b";
const SHOW = JSON.parse(readFileSync(new URL("../fit/fixtures/show-qwen3-5-9b.json", import.meta.url), "utf8")) as unknown;
const line = (v: unknown) => `${JSON.stringify(v)}\n`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await sleep(10);
  }
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).toReversed()) await c();
});

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  cleanups.push(release);
  return { promise, release };
}

/** A fake Ollama with MODEL installed, `ps` as /api/ps, and the app, runtime, loader and handlers around it. */
async function setup(ps: string[], routes: Record<string, Route>, lease?: GpuLease) {
  const tags = [MODEL];
  const ollama: FakeServer = await startFakeServer({
    "GET /": (_b, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Ollama is running");
    },
    "GET /api/version": (_b, res) => json(res, 200, { version: "0.0.9-fake" }),
    "GET /api/tags": (_b, res) => json(res, 200, { models: tags.map((name) => ({ name, size: 6594474711, digest: "a", modified_at: "2026-11-01T00:00:00Z" })) }),
    "GET /api/ps": (_b, res) => json(res, 200, { models: ps.map((name) => ({ name, size: 1, size_vram: 1 })) }),
    "POST /api/show": (_b, res) => json(res, 200, SHOW),
    "DELETE /api/delete": (_b, res) => {
      tags.splice(0);
      res.writeHead(200).end();
    },
    ...routes,
  });
  cleanups.push(() => ollama.close());
  const dir = mkdtempSync(path.join(os.tmpdir(), "gates-app-hook-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = openThreadStore(path.join(dir, "threads.sqlite"));
  cleanups.push(() => store.close());
  const runtime = createOllamaRuntime({ externalBaseUrl: ollama.baseUrl, appPort: await freePort(), appDataDir: dir, allowInstall: false, env: { PATH: "" }, systemModelsDirs: [], probeTimeoutMs: 500 });
  await runtime.discover();
  const catalog = createModelCatalog(() => runtime.baseUrl());
  cleanups.push(() => catalog.stop()); // no discovery retry outlives the test (MP2-04)

  const pushes: { channel: Channel; payload: unknown }[] = [];
  const push = (channel: Channel, payload: unknown) => void pushes.push({ channel, payload });
  const loader = createModelLoader({
    baseUrl: () => runtime.baseUrl(),
    push: (l) => push("models.load", l),
    listLoaded: (url) => listLoaded(url),
    fit: async () => {
      throw new Error("not used by a turn");
    },
    ...(lease ? { lease } : {}),
  });
  const pulls = createPullManager({ baseUrl: () => runtime.baseUrl(), push: () => undefined });
  cleanups.push(() => pulls.stop());
  const handlers = createRuntimeHandlers({
    baseUrl: () => runtime.baseUrl(),
    catalog,
    settings: { get: () => defaultSettings("system") },
    pulls,
    loader,
  });
  const app = createApp({
    store,
    runtime,
    catalog,
    push,
    models: { handlers, loader },
    ...(lease ? { lease } : {}),
    fit: {
      runNvidiaSmi: async (args) => (args[0]?.startsWith("--query-gpu") ? "16303, 1303, 15000\n" : ""),
      readMeminfo: async () => "MemAvailable: 30000000 kB\n",
    },
    log: () => undefined,
  });
  cleanups.push(() => app.shutdown());
  const loads = () => pushes.filter((p) => p.channel === "models.load").map((p) => (p.payload as ModelLoad).state);
  const thread = store.createThread({});
  const send = () => Promise.resolve(app.handlers["chat.send"]({ threadId: thread.id, content: "hello", model: MODEL, numCtx: 16384 }, { clientId: 1 }));
  const remove = () => Promise.resolve(app.handlers["models.remove"]?.({ name: MODEL }, { clientId: 1 }));
  return { app, loader, ollama, loads, send, remove, pulls };
}

it("RS-01: models.pulls reads live progress and queued jobs through the app handler", async () => {
  const held = deferred();
  const { app, pulls } = await setup([], {
    "POST /api/pull": async (_b, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(line({ status: "pulling weights", digest: "sha256:weights", total: 1000, completed: 400 }));
      await held.promise;
      res.end(line({ status: "success" }));
    },
  });
  const read = () => app.handlers["models.pulls"]?.({}, { clientId: 1 });
  expect(await read()).toEqual([]);
  pulls.pull(MODEL);
  pulls.pull("waiting:7b");
  await until(() => pulls.pending()[0]?.completedBytes === 400);
  expect(await read()).toEqual([
    { name: MODEL, state: "downloading", completedBytes: 400, totalBytes: 1000 },
    { name: "waiting:7b", state: "queued", completedBytes: 0 },
  ]);
  expect(pulls.cancel("waiting:7b")).toBe(true);
  held.release();
  await until(() => pulls.pending().length === 0);
  expect(await read()).toEqual([]);
});

it("a turn on a cold model pushes loading, then ready at the first token, and the app owns the model", async () => {
  const ps: string[] = [];
  // The reply stays open after its first token until the test has seen
  // "ready", so ready must come from the first token, not the turn's end.
  const held = deferred();
  const { app, loader, loads, send } = await setup(ps, {
    "POST /api/chat": async (_b, res) => {
      ps.push(MODEL);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(line({ model: MODEL, message: { role: "assistant", content: "hi" }, done: false }));
      await held.promise;
      res.end(line({ model: MODEL, message: { role: "assistant", content: "" }, done: true, done_reason: "stop", eval_count: 1, prompt_eval_count: 1 }));
    },
  });

  expect(typeof app.handlers["models.catalog"]).toBe("function");
  await send();
  await until(() => loads().includes("ready"));
  expect(loads()).toEqual(["loading", "ready"]);
  expect(loader.appLoadedModels()).toEqual([MODEL]);
  expect(loader.inUse(MODEL)).toBe(true);
  // The turn is no longer counted once it ends.
  held.release();
  await until(() => app.activeTurns() === 0);
  expect(loader.inUse(MODEL)).toBe(false);
});

it("R-04: a cold turn whose first event is an error claims nothing and pushes no ready", async () => {
  const { app, loader, loads, send } = await setup([], {
    "POST /api/chat": (_b, res) => json(res, 500, { error: "model requires more system memory (12.0 GiB) than is available (4.0 GiB)" }),
  });
  await send();
  await until(() => app.activeTurns() === 0);
  await until(() => loads().length === 2);
  expect(loads()).toEqual(["loading", "unloaded"]);
  expect(loader.appLoadedModels()).toEqual([]);
});

it("R-05: with a slow /api/ps, the model a cold turn loaded still ends up owned", async () => {
  const ps: string[] = [];
  const { app, loader, loads, send } = await setup(ps, {
    "GET /api/ps": async (_b, res) => {
      const snapshot = [...ps];
      await sleep(150);
      json(res, 200, { models: snapshot.map((name) => ({ name, size: 1, size_vram: 1 })) });
    },
    "POST /api/chat": (_b, res) => {
      ps.push(MODEL);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(line({ model: MODEL, message: { role: "assistant", content: "hi" }, done: false }));
      res.end(line({ model: MODEL, message: { role: "assistant", content: "" }, done: true, done_reason: "stop", eval_count: 1, prompt_eval_count: 1 }));
    },
  });
  await send();
  await until(() => app.activeTurns() === 0);
  await sleep(400);
  expect(loader.appLoadedModels()).toEqual([MODEL]);
  expect(loads()).toEqual(["loading", "ready"]);
});

it("R-07: models.remove refuses while a send waits on its fit (held /api/show)", async () => {
  const show = deferred();
  const { ollama, send, remove } = await setup([], {
    "POST /api/show": async (_b, res) => {
      await show.promise;
      json(res, 200, SHOW);
    },
    "POST /api/chat": (_b, res) => json(res, 500, { error: "not reached in this test" }),
  });
  const sending = send().catch((e: unknown) => e);
  await until(() => ollama.requests.some((r) => r.path === "/api/show"));
  const refused = await remove().catch((e: unknown) => e);
  expect(refused).toBeInstanceOf(ModelActionError);
  expect((refused as ModelActionError).code).toBe("model-in-use");
  expect(ollama.requests.some((r) => r.path === "/api/delete")).toBe(false);
  show.release();
  await sending;
});

it("R-07: a send while the model's DELETE is pending refuses before any fit", async () => {
  const del = deferred();
  const { ollama, app, send, remove } = await setup([], {
    "DELETE /api/delete": async (_b, res) => {
      await del.promise;
      res.writeHead(200).end();
    },
  });
  const removing = remove();
  await until(() => ollama.requests.some((r) => r.path === "/api/delete"));
  const refused = await send().catch((e: unknown) => e);
  expect(refused).toBeInstanceOf(ModelActionError);
  expect((refused as ModelActionError).code).toBe("model-removing");
  expect((refused as Error).message).toMatch(/is being removed/);
  expect(ollama.requests.some((r) => r.path === "/api/show" || r.path === "/api/chat")).toBe(false);
  expect(app.activeTurns()).toBe(0);
  del.release();
  await removing;
});

const reply = (res: import("node:http").ServerResponse) => {
  res.writeHead(200, { "content-type": "application/x-ndjson" });
  res.write(line({ model: MODEL, message: { role: "assistant", content: "hi" }, done: false }));
  res.end(line({ model: MODEL, message: { role: "assistant", content: "" }, done: true, done_reason: "stop", eval_count: 1, prompt_eval_count: 1 }));
};
const chats = (ollama: FakeServer) => ollama.requests.filter((r) => r.method === "POST" && r.path === "/api/chat").length;

it("a turn waits while an image job holds the GPU, then streams once the job ends", async () => {
  const lease = createGpuLease();
  const releaseImage = await lease.acquire("image");
  const { app, ollama, send } = await setup([MODEL], { "POST /api/chat": (_b, res) => reply(res) }, lease);
  let sent = false;
  const sending = send().then(() => (sent = true));
  await sleep(100);
  expect([sent, chats(ollama)]).toEqual([false, 0]);
  expect(lease.status()).toEqual({ holder: "image", holders: 1, waiting: ["chat"] });
  releaseImage();
  await sending;
  await until(() => app.activeTurns() === 0);
  expect(chats(ollama)).toBe(1);
  expect(lease.status()).toEqual({ holder: null, holders: 0, waiting: [] });
});

it("an image job waits until a streaming turn ends", async () => {
  const lease = createGpuLease();
  const held = deferred();
  const { app, ollama, send } = await setup([MODEL], {
    "POST /api/chat": async (_b, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(line({ model: MODEL, message: { role: "assistant", content: "hi" }, done: false }));
      await held.promise;
      res.end(line({ model: MODEL, message: { role: "assistant", content: "" }, done: true, done_reason: "stop", eval_count: 1, prompt_eval_count: 1 }));
    },
  }, lease);
  await send();
  await until(() => chats(ollama) === 1);
  let imaged = false;
  const image = lease.run("image", undefined, async () => { imaged = true; });
  await sleep(100);
  expect(imaged).toBe(false);
  expect(lease.status()).toEqual({ holder: "chat", holders: 1, waiting: ["image"] });
  held.release();
  await image;
  expect(imaged).toBe(true);
  await until(() => app.activeTurns() === 0);
});

it("a turn that ends in an error, or is cancelled while it waits for the GPU, gives its claim back", async () => {
  const lease = createGpuLease();
  const { app, send } = await setup([MODEL], {
    "POST /api/chat": (_b, res) => json(res, 500, { error: "boom" }),
  }, lease);
  await send();
  await until(() => app.activeTurns() === 0);
  expect(lease.status()).toEqual({ holder: null, holders: 0, waiting: [] });

  const releaseImage = await lease.acquire("image");
  const waiting = send();
  await sleep(50);
  expect(lease.status().waiting).toEqual(["chat"]);
  await app.shutdown();
  await expect(waiting).rejects.toMatchObject({ code: "cancelled" });
  expect(lease.status()).toEqual({ holder: "image", holders: 1, waiting: [] });
  releaseImage();
  expect(lease.status()).toEqual({ holder: null, holders: 0, waiting: [] });
});

it("models.load does nothing while an image job holds the GPU", async () => {
  const lease = createGpuLease();
  const releaseImage = await lease.acquire("image");
  const { app, ollama } = await setup([MODEL], {}, lease);
  const before = ollama.requests.length;
  let done = false;
  const loading = Promise.resolve(app.handlers["models.load"]?.({ model: MODEL, numCtx: 16384 }, { clientId: 1 })).then(() => (done = true));
  await sleep(100);
  expect([done, ollama.requests.length - before]).toEqual([false, 0]);
  releaseImage();
  await loading;
  expect(ollama.requests.slice(before).some((r) => r.path === "/api/ps")).toBe(true);
});
