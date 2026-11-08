import type { FitReport, ModelLoad } from "@gates-local/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { json, startFakeServer, type FakeServer, type Route } from "../fit/fake-http.ts";
import { defaultSettings } from "../settings/store.ts";
import { createRuntimeHandlers } from "./handlers.ts";
import { ModelActionError, createModelLoader, type ModelLoaderDeps } from "./load.ts";
import { createModelCatalog, listLoaded } from "./models.ts";
import { createPullManager } from "./pull.ts";

const servers: FakeServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const tick = () => new Promise((r) => setTimeout(r, 5));
async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await tick();
  }
}

const GB = 1024 ** 3;
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

/** A fake Ollama whose /api/ps is `ps`; /api/generate makes the model resident. `over` replaces routes. */
async function fakeOllama(ps: string[], tags: string[] = [], over: Record<string, Route> = {}): Promise<FakeServer> {
  const server = await startFakeServer({
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
    ...over,
  });
  servers.push(server);
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

const generates = (s: FakeServer) => s.requests.filter((r) => r.path === "/api/generate").length;

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
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
    expect(generates(s)).toBe(0);

    const failed = await loaderFor(s, pushes).load("broken:1b", 16384);
    expect(failed.state).toBe("error");
    expect(failed.message).toBe("Could not load broken:1b: llama runner process has terminated: exit status 2");
  });

  it("R-01: a model already resident that the app did not load is external: ready, no preload, never owned", async () => {
    // `ollama run m` in a terminal.
    const s = await fakeOllama(["m:latest"]);
    const pushes: ModelLoad[] = [];
    const loader = loaderFor(s, pushes);
    const r = await loader.load("m", 16384);
    expect(r.state).toBe("ready");
    expect(pushes.map((p) => p.state)).toEqual(["ready"]);
    expect(loader.appLoadedModels()).toEqual([]);
    expect(generates(s)).toBe(0);
  });

  it("R-03: an HTTP 200 whose body carries an error (or no done: true) is a failed load, nothing owned", async () => {
    let body: unknown = { error: "model requires more system memory (12.0 GiB) than is available (4.0 GiB)" };
    const s = await fakeOllama([], [], { "POST /api/generate": (_b, res) => json(res, 200, body) });
    const pushes: ModelLoad[] = [];
    const loader = loaderFor(s, pushes);
    const r = await loader.load("m", 16384);
    expect(pushes.map((p) => p.state)).toEqual(["loading", "error"]);
    expect(r.message).toBe("Could not load m: model requires more system memory (12.0 GiB) than is available (4.0 GiB)");
    expect(loader.appLoadedModels()).toEqual([]);

    body = { model: "m", response: "" };
    expect((await loader.load("m", 16384)).message).toBe("Could not load m: Ollama answered without saying the model finished loading.");
    expect(loader.appLoadedModels()).toEqual([]);
  });

  it("R-06: two simultaneous 6 GB preloads against 10 GB free: the second fit sees the first load, one /api/generate", async () => {
    let free = 10 * GB;
    const ps: string[] = [];
    const s = await fakeOllama(ps, [], {
      "POST /api/generate": (b, res) => {
        const model = (b as { model: string }).model;
        free -= 6 * GB;
        ps.push(model);
        json(res, 200, { model, response: "", done: true });
      },
    });
    const pushes: ModelLoad[] = [];
    const loader = loaderFor(s, pushes, "fits", {
      // Measured at the moment it runs, like the real check.
      fit: async (model) => {
        await tick();
        return { ...report(free >= 6 * GB ? "fits" : "refuse"), model, freeVramBytes: free, needVramBytes: 6 * GB };
      },
    });
    const [a, b] = await Promise.all([loader.load("a:7b", 16384), loader.load("b:7b", 16384)]);
    expect(a.state).toBe("ready");
    expect(b.state).toBe("error");
    expect(generates(s)).toBe(1);
    expect(loader.appLoadedModels()).toEqual(["a:7b"]);
  });
});

describe("runtime generation", () => {
  it("R-02: after a switch to B where m is external, B's m is never app-owned", async () => {
    const a = await fakeOllama([]);
    const b = await fakeOllama(["m:latest"]);
    let url = a.baseUrl;
    const pushes: ModelLoad[] = [];
    const loader = createModelLoader({ baseUrl: () => url, push: (l) => pushes.push(l), listLoaded: (u) => listLoaded(u), fit: async () => report("fits") });
    await loader.load("m", 16384);
    expect(loader.appLoadedModels()).toEqual(["m:latest"]);

    loader.runtimeChanged();
    url = b.baseUrl;
    const before = pushes.length;
    // The GPU poll reads B's /api/ps, which lists m (someone else's there).
    loader.prune(["m:latest"]);
    expect(loader.appLoadedModels()).toEqual([]);
    // A turn on B with m resident is warm: nothing claimed.
    const turn = loader.reserve("m");
    await turn.admit(16384);
    turn.firstToken();
    turn.end();
    expect(loader.appLoadedModels()).toEqual([]);
    // The switch itself pushes no "unloaded" for a model that stays resident elsewhere.
    expect(pushes.slice(before).filter((p) => p.state === "unloaded")).toEqual([]);
  });

  it("R-02: an A preload that resolves after the switch adds nothing", async () => {
    const hold = deferred();
    const a = await fakeOllama([], [], {
      "POST /api/generate": async (b, res) => {
        await hold.promise;
        json(res, 200, { model: (b as { model: string }).model, response: "", done: true });
      },
    });
    const b = await fakeOllama([]);
    let url = a.baseUrl;
    const pushes: ModelLoad[] = [];
    const loader = createModelLoader({ baseUrl: () => url, push: (l) => pushes.push(l), listLoaded: (u) => listLoaded(u), fit: async () => report("fits") });
    const pending = loader.load("m", 16384);
    await until(() => generates(a) === 1);
    loader.runtimeChanged();
    url = b.baseUrl;
    hold.release();
    const r = await pending;
    expect(r.state).toBe("error");
    expect(r.message).toMatch(/runtime changed while m was loading/);
    expect(loader.appLoadedModels()).toEqual([]);
  });
});

describe("chat turn reservation", () => {
  it("pushes loading for a model not in /api/ps (decided in admit) and ready at the first token; a resident model pushes nothing", async () => {
    const ps: string[] = ["gemma4:12b"];
    const s = await fakeOllama(ps);
    const pushes: ModelLoad[] = [];
    const loader = loaderFor(s, pushes);

    const warm = loader.reserve("gemma4:12b");
    await warm.admit(16384);
    warm.firstToken();
    warm.end();
    expect(pushes).toEqual([]);

    const cold = loader.reserve("qwen3.5:9b");
    expect(loader.inUse("qwen3.5:9b")).toBe(true);
    await cold.admit(16384);
    expect(pushes).toEqual([{ model: "qwen3.5:9b", numCtx: 16384, state: "loading" }]);
    ps.push("qwen3.5:9b");
    cold.firstToken();
    expect(pushes[1]?.state).toBe("ready");
    cold.end();
    expect(loader.inUse("qwen3.5:9b")).toBe(false);
    // Only the model this app's turn loaded is the app's to unload.
    expect(loader.appLoadedModels()).toEqual(["qwen3.5:9b"]);
  });

  it("R-05: with a slow /api/ps the residency decision still lands before the first token, so the cold model is owned", async () => {
    const ps: string[] = [];
    const s = await fakeOllama(ps, [], {
      "GET /api/ps": async (_b, res) => {
        const snapshot = [...ps];
        await new Promise((r) => setTimeout(r, 150));
        json(res, 200, { models: snapshot.map((name) => ({ name, size: 1, size_vram: 1 })) });
      },
    });
    const pushes: ModelLoad[] = [];
    const loader = loaderFor(s, pushes);
    const turn = loader.reserve("qwen3.5:9b");
    await turn.admit(16384);
    // The chat request goes out now; Ollama answers at once.
    ps.push("qwen3.5:9b");
    turn.firstToken();
    turn.end();
    await tick();
    expect(loader.appLoadedModels()).toEqual(["qwen3.5:9b"]);
    expect(pushes.map((p) => p.state)).toEqual(["loading", "ready"]);
  });

  it("a turn that ends before any token reports what /api/ps says; pruning drops a model Ollama let go of", async () => {
    const ps: string[] = [];
    const s = await fakeOllama(ps);
    const pushes: ModelLoad[] = [];
    const loader = loaderFor(s, pushes);
    const turn = loader.reserve("qwen3.5:9b");
    await turn.admit(16384);
    turn.end();
    await until(() => pushes.length === 2);
    expect(pushes.map((p) => p.state)).toEqual(["loading", "unloaded"]);

    await loader.load("gemma4:12b", 16384);
    loader.prune(["something-else:7b"]);
    expect(loader.appLoadedModels()).toEqual([]);
    expect(pushes.at(-1)).toEqual({ model: "gemma4:12b", numCtx: 16384, state: "unloaded" });
  });

  it("a refused admit releases the reservation", async () => {
    const s = await fakeOllama([]);
    const loader = loaderFor(s, [], "refuse");
    const turn = loader.reserve("big:70b");
    expect((await turn.admit(16384)).verdict).toBe("refuse");
    expect(loader.inUse("big:70b")).toBe(false);
  });

  it("R-06: two cold chat turns run their fits one after the other; a warm turn holds the gate only for its fit", async () => {
    const s = await fakeOllama(["warm:1b"]);
    const loader = loaderFor(s, []);
    let running = 0;
    let most = 0;
    const started: string[] = [];
    const fit = (name: string) => async () => {
      started.push(name);
      running++;
      most = Math.max(most, running);
      await tick();
      running--;
      return report("fits");
    };
    const a = loader.reserve("a:7b");
    const b = loader.reserve("b:7b");
    const admittedA = a.admit(16384, { fit: fit("a") });
    const admittedB = b.admit(16384, { fit: fit("b") });
    await admittedA;
    // a is a cold load and holds the gate until its first token: b has not started its fit.
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toEqual(["a"]);
    a.firstToken();
    await admittedB;
    expect(started).toEqual(["a", "b"]);
    expect(most).toBe(1);
    b.end();
    a.end();

    const warm = loader.reserve("warm:1b");
    await warm.admit(16384, { fit: fit("warm") });
    // Warm: released at once, so a preload runs while the turn streams.
    expect((await loader.load("c:1b", 16384)).state).toBe("ready");
    warm.end();
  });

  it("an aborted wait for the gate rejects at once and releases the reservation", async () => {
    const s = await fakeOllama([]);
    const loader = loaderFor(s, []);
    const holder = loader.reserve("a:7b");
    await holder.admit(16384);
    const controller = new AbortController();
    const waiting = loader.reserve("b:7b");
    const admitted = waiting.admit(16384, { signal: controller.signal });
    controller.abort();
    await expect(admitted).rejects.toMatchObject({ name: "AdmitCancelled" });
    expect(loader.inUse("b:7b")).toBe(false);
    holder.end();
  });
});

describe("models.remove", () => {
  it("refuses while a turn holds the model, otherwise deletes and refreshes the list", async () => {
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

    const turn = loader.reserve("qwen3.5:9b");
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
    // A failed removal lets the model be used again.
    expect(() => loader.reserve("nope:1b").end()).not.toThrow();
  });
});
