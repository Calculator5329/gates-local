// app.ts's models deps field in process: a chat turn on a model that is not
// in /api/ps pushes models.load "loading", then "ready" once the reply
// starts, and the module handlers are reachable through app.handlers.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Channel, ModelLoad } from "@gates-local/contracts";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { json, startFakeServer, type FakeServer } from "../fit/fake-http.ts";
import { defaultSettings } from "../settings/store.ts";
import { openThreadStore } from "../threads/store.ts";
import { createRuntimeHandlers } from "./handlers.ts";
import { createModelLoader } from "./load.ts";
import { createModelCatalog, listLoaded } from "./models.ts";
import { createPullManager } from "./pull.ts";
import { createOllamaRuntime } from "./runtime.ts";
import { freePort } from "./test-fakes.ts";

const MODEL = "qwen3.5:9b";
const SHOW = JSON.parse(readFileSync(new URL("../fit/fixtures/show-qwen3-5-9b.json", import.meta.url), "utf8")) as unknown;
const line = (v: unknown) => `${JSON.stringify(v)}\n`;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).toReversed()) await c();
});

it("a turn on a cold model pushes loading, then ready at the first token, and the app owns the model", async () => {
  const ps: string[] = [];
  // The reply stays open after its first token until the test has seen
  // "ready", so ready must come from the first token, not the turn's end.
  const gate: { release?: () => void } = {};
  const held = new Promise<void>((r) => (gate.release = r));
  const release = () => gate.release?.();
  cleanups.push(release);
  const ollama: FakeServer = await startFakeServer({
    "GET /": (_b, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Ollama is running");
    },
    "GET /api/version": (_b, res) => json(res, 200, { version: "0.0.9-fake" }),
    "GET /api/tags": (_b, res) => json(res, 200, { models: [{ name: MODEL, size: 6594474711, digest: "a", modified_at: "2026-11-01T00:00:00Z" }] }),
    "GET /api/ps": (_b, res) => json(res, 200, { models: ps.map((name) => ({ name, size: 1, size_vram: 1 })) }),
    "POST /api/show": (_b, res) => json(res, 200, SHOW),
    "POST /api/chat": async (_b, res) => {
      ps.push(MODEL);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(line({ model: MODEL, message: { role: "assistant", content: "hi" }, done: false }));
      await held;
      res.end(line({ model: MODEL, message: { role: "assistant", content: "" }, done: true, done_reason: "stop", eval_count: 1, prompt_eval_count: 1 }));
    },
  });
  cleanups.push(() => ollama.close());
  const dir = mkdtempSync(path.join(os.tmpdir(), "gates-app-hook-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = openThreadStore(path.join(dir, "threads.sqlite"));
  cleanups.push(() => store.close());
  const runtime = createOllamaRuntime({ externalBaseUrl: ollama.baseUrl, appPort: await freePort(), appDataDir: dir, allowInstall: false, env: { PATH: "" }, systemModelsDirs: [], probeTimeoutMs: 500 });
  await runtime.discover();
  const catalog = createModelCatalog(() => runtime.baseUrl());

  const pushes: { channel: Channel; payload: unknown }[] = [];
  const push = (channel: Channel, payload: unknown) => void pushes.push({ channel, payload });
  const loader = createModelLoader({
    baseUrl: () => runtime.baseUrl(),
    push: (l) => push("models.load", l),
    listLoaded: (url) => listLoaded(url),
    fit: async () => {
      throw new Error("not used by a turn");
    },
  });
  const handlers = createRuntimeHandlers({
    baseUrl: () => runtime.baseUrl(),
    catalog,
    settings: { get: () => defaultSettings("system") },
    pulls: createPullManager({ baseUrl: () => runtime.baseUrl(), push: () => undefined }),
    loader,
  });
  const app = createApp({
    store,
    runtime,
    catalog,
    push,
    models: { handlers, loader },
    fit: {
      runNvidiaSmi: async (args) => (args[0]?.startsWith("--query-gpu") ? "16303, 1303, 15000\n" : ""),
      readMeminfo: async () => "MemAvailable: 30000000 kB\n",
    },
    log: () => undefined,
  });
  cleanups.push(() => app.shutdown());

  expect(typeof app.handlers["models.catalog"]).toBe("function");
  const ctx = { clientId: 1 };
  const thread = store.createThread({});
  await app.handlers["chat.send"]({ threadId: thread.id, content: "hello", model: MODEL, numCtx: 16384 }, ctx);
  const loads = () => pushes.filter((p) => p.channel === "models.load").map((p) => (p.payload as ModelLoad).state);
  const end = Date.now() + 3000;
  while (!loads().includes("ready") && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  expect(loads()).toEqual(["loading", "ready"]);
  expect(loader.appLoadedModels()).toEqual([MODEL]);
  expect(loader.inUse(MODEL)).toBe(true);
  // The turn is no longer counted once it ends.
  release();
  while (app.activeTurns() > 0) await new Promise((r) => setTimeout(r, 10));
  expect(loader.inUse(MODEL)).toBe(false);
});
