import type { FitReport, ModelLoad } from "@gates-local/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { json, startFakeServer, type FakeServer } from "../fit/fake-http.ts";
import { defaultSettings } from "../settings/store.ts";
import { createRuntimeHandlers } from "./handlers.ts";
import { ModelActionError, createModelLoader, type ModelLoaderDeps } from "./load.ts";
import { createModelCatalog, listLoaded } from "./models.ts";
import { createPullManager } from "./pull.ts";

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const tick = () => new Promise((r) => setTimeout(r, 5));
async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await tick();
  }
}

const report = (verdict: FitReport["verdict"]): FitReport => ({
  model: "m",
  numCtx: 16384,
  freeVramBytes: 0,
  needVramBytes: 0,
  spillRamBytes: 0,
  verdict,
  source: "estimate",
  measuredAt: 0,
  ...(verdict === "refuse" ? { message: "needs 30 GB, 12 GB free" } : {}),
});

/** A fake Ollama whose /api/ps is `ps`; /api/generate makes the model resident. */
async function fakeOllama(ps: string[], tags: string[] = []): Promise<FakeServer> {
  server = await startFakeServer({
    "GET /api/ps": (_b, res) => json(res, 200, { models: ps.map((name) => ({ name, size: 1, size_vram: 1 })) }),
    "GET /api/tags": (_b, res) => json(res, 200, { models: tags.map((name) => ({ name, size: 1, digest: name, modified_at: "2026-11-01T00:00:00Z" })) }),
    "POST /api/generate": (body, res) => {
      const model = (body as { model: string }).model;
      if (model === "broken:1b") return json(res, 500, { error: "llama runner process has terminated: exit status 2" });
      ps.push(model);
      json(res, 200, { model, response: "", done: true, done_reason: "load" });
    },
    "DELETE /api/delete": (body, res) => {
      const model = (body as { model: string }).model;
      const i = tags.indexOf(model);
      if (i < 0) return json(res, 404, { error: `model '${model}' not found` });
      tags.splice(i, 1);
      res.writeHead(200).end();
    },
  });
  return server;
}

function loaderFor(s: FakeServer, pushes: ModelLoad[], fit: FitReport["verdict"] = "fits", extra: Partial<ModelLoaderDeps> = {}) {
  return createModelLoader({
    baseUrl: () => s.baseUrl,
    push: (l) => pushes.push(l),
    listLoaded: (url) => listLoaded(url),
    fit: async () => report(fit),
    ...extra,
  });
}

describe("models.load", () => {
  it("preloads with an empty prompt, keep_alive and num_ctx, pushes loading then ready, and owns the model", async () => {
    const s = await fakeOllama([]);
    const pushes: ModelLoad[] = [];
    let pokes = 0;
    const loader = loaderFor(s, pushes, "fits", { onLoaded: () => pokes++ });
    expect(await loader.load("qwen3.5:9b", 32768)).toEqual({ model: "qwen3.5:9b", numCtx: 32768, state: "ready" });
    expect(pushes.map((p) => p.state)).toEqual(["loading", "ready"]);
    expect(s.requests.find((r) => r.path === "/api/generate")?.body).toEqual({
      model: "qwen3.5:9b",
      prompt: "",
      stream: false,
      keep_alive: "5m",
      options: { num_ctx: 32768 },
    });
    expect(loader.appLoadedModels()).toEqual(["qwen3.5:9b"]);
    expect(pokes).toBe(1);
  });

  it("a refusal never reaches Ollama; a failed load ends in error with Ollama's words", async () => {
    const s = await fakeOllama([]);
    const pushes: ModelLoad[] = [];
    const refused = await loaderFor(s, pushes, "refuse").load("big:70b", 16384);
    expect(refused).toEqual({ model: "big:70b", numCtx: 16384, state: "error", message: "needs 30 GB, 12 GB free" });
    expect(s.requests.some((r) => r.path === "/api/generate")).toBe(false);

    const failed = await loaderFor(s, pushes).load("broken:1b", 16384);
    expect(failed.state).toBe("error");
    expect(failed.message).toBe("Could not load broken:1b: llama runner process has terminated: exit status 2");
  });
});

describe("chat turn load hook", () => {
  it("pushes loading for a model not in /api/ps and ready at the first token; a resident model pushes nothing", async () => {
    const ps: string[] = ["gemma4:12b"];
    const s = await fakeOllama(ps);
    const pushes: ModelLoad[] = [];
    const loader = loaderFor(s, pushes);

    const warm = loader.beginTurn("gemma4:12b", 16384);
    await tick();
    warm.firstToken();
    warm.end();

    const cold = loader.beginTurn("qwen3.5:9b", 16384);
    expect(loader.inUse("qwen3.5:9b")).toBe(true);
    await until(() => pushes.length === 1);
    expect(pushes[0]).toEqual({ model: "qwen3.5:9b", numCtx: 16384, state: "loading" });
    ps.push("qwen3.5:9b");
    cold.firstToken();
    await until(() => pushes.length === 2);
    expect(pushes[1]?.state).toBe("ready");
    cold.end();
    expect(loader.inUse("qwen3.5:9b")).toBe(false);
    // Only the model this app's turn loaded is the app's to unload.
    expect(loader.appLoadedModels()).toEqual(["qwen3.5:9b"]);
  });

  it("a turn that ends before any token reports what /api/ps says; pruning drops a model Ollama let go of", async () => {
    const ps: string[] = [];
    const s = await fakeOllama(ps);
    const pushes: ModelLoad[] = [];
    const loader = loaderFor(s, pushes);
    loader.beginTurn("qwen3.5:9b", 16384).end();
    await until(() => pushes.length === 2);
    expect(pushes.map((p) => p.state)).toEqual(["loading", "unloaded"]);

    await loader.load("gemma4:12b", 16384);
    loader.prune(["something-else:7b"]);
    expect(loader.appLoadedModels()).toEqual([]);
    expect(pushes.at(-1)).toEqual({ model: "gemma4:12b", numCtx: 16384, state: "unloaded" });
  });
});

describe("models.remove", () => {
  it("refuses while a turn uses the model, otherwise deletes and refreshes the list", async () => {
    const tags = ["qwen3.5:9b", "gemma4:12b"];
    const s = await fakeOllama([], tags);
    const loader = loaderFor(s, []);
    const catalog = createModelCatalog(() => s.baseUrl, { minIntervalMs: 60_000 });
    await catalog.refresh();
    const h = createRuntimeHandlers({
      baseUrl: () => s.baseUrl,
      catalog,
      settings: { get: () => defaultSettings("system") },
      pulls: createPullManager({ baseUrl: () => s.baseUrl, push: () => undefined }),
      loader,
    });

    const turn = loader.beginTurn("qwen3.5:9b", 16384);
    const refused = await h["models.remove"]({ name: "qwen3.5:9b" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ModelActionError);
    expect((refused as ModelActionError).code).toBe("model-in-use");
    expect(s.requests.some((r) => r.path === "/api/delete")).toBe(false);
    turn.end();

    expect(await h["models.remove"]({ name: "qwen3.5:9b" })).toEqual({ name: "qwen3.5:9b" });
    // Forced past the 60 s throttle.
    expect(catalog.current()?.map((m) => m.name)).toEqual(["gemma4:12b"]);

    const missing = await h["models.remove"]({ name: "nope:1b" }).catch((e: unknown) => e);
    expect((missing as ModelActionError).code).toBe("remove-failed");
    expect((missing as Error).message).toBe("Could not remove nope:1b: model 'nope:1b' not found");
  });
});
