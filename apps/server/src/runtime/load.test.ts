import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FitReport, ModelLoad } from "@gates-local/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { json, startFakeServer, type FakeServer, type Route } from "../fit/fake-http.ts";
import { checkFit } from "../fit/fit.ts";
import { createGpuLease } from "../gpu/lease.ts";
import { defaultSettings } from "../settings/store.ts";
import { createRuntimeHandlers } from "./handlers.ts";
import { ModelActionError, createModelLoader, type ModelLoader, type ModelLoaderDeps } from "./load.ts";
import { createModelCatalog, listLoaded } from "./models.ts";
import { createPullManager } from "./pull.ts";
import { ownedIdleComfy } from "./test-image.ts";

const servers: FakeServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const tick = () => new Promise((r) => setTimeout(r, 5));
async function until(pred: () => boolean, ms = 20_000): Promise<void> {
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

/**
 * A fake Ollama whose /api/ps is `ps`, each loaded at num_ctx 16384 (the context every test turn uses);
 * /api/generate makes the model resident. `over` replaces routes.
 */
async function fakeOllama(ps: string[], tags: string[] = [], over: Record<string, Route> = {}): Promise<FakeServer> {
  const server = await startFakeServer({
    "GET /api/ps": (_b, res) => json(res, 200, { models: ps.map((name) => ({ name, size: 1, size_vram: 1, context_length: 16384 })) }),
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
    fit: async (_model, numCtx) => ({ ...report(fit), numCtx }),
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
  it("loads at the context the fit settled on, not a larger one that was asked for", async () => {
    const s = await fakeOllama([]);
    const pushes: ModelLoad[] = [];
    const loader = loaderFor(s, pushes, "fits", { fit: async () => ({ ...report("fits"), numCtx: 2048 }) });
    expect(await loader.load("qwen3.5:9b", 16384)).toEqual({ model: "qwen3.5:9b", numCtx: 2048, state: "ready" });
    expect(s.requests.find((r) => r.path === "/api/generate")?.body).toMatchObject({ options: { num_ctx: 2048 } });
    expect(pushes.map((p) => p.numCtx)).toEqual([2048, 2048]);
  });

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

  it("reselecting an owned resident model at the same context never queues an empty generate behind its reply", async () => {
    const s = await fakeOllama([]);
    const pushes: ModelLoad[] = [];
    const loader = loaderFor(s, pushes);
    await loader.load("m:latest", 16384);
    const turn = loader.reserve("m:latest");
    await turn.admit(16384);
    await loader.load("m:latest", 16384);
    expect(generates(s)).toBe(1);
    expect(pushes.at(-1)).toMatchObject({ state: "ready", numCtx: 16384 });
    turn.end();
    await loader.load("m:latest", 32768);
    expect(generates(s)).toBe(2);
  });

  it("a second request for a model already loading joins that load: one fit, one generate, one loading and one ready", async () => {
    const generate = deferred();
    const ps: string[] = [];
    const s = await fakeOllama(ps, [], {
      "POST /api/generate": async (b, res) => {
        await generate.promise;
        const model = (b as { model: string }).model;
        ps.push(model);
        json(res, 200, { model, response: "", done: true });
      },
    });
    const pushes: ModelLoad[] = [];
    let fits = 0;
    const loader = loaderFor(s, pushes, "fits", { fit: async (_m, numCtx) => (fits++, { ...report("fits"), numCtx }) });
    const first = loader.load("gemma4:12b", 16384);
    await until(() => generates(s) === 1);
    const second = loader.load("gemma4:12b", 16384);
    generate.release();
    const both = await Promise.all([first, second]);
    expect(both).toEqual([{ model: "gemma4:12b", numCtx: 16384, state: "ready" }, { model: "gemma4:12b", numCtx: 16384, state: "ready" }]);
    expect(pushes.map((p) => p.state)).toEqual(["loading", "ready"]);
    expect(fits).toBe(1);
    expect(generates(s)).toBe(1);
    // Over: the next request is a load of its own again (here a resident one, so no generate).
    await loader.load("gemma4:12b", 16384);
    expect(fits).toBe(2);
    expect(generates(s)).toBe(1);
  });

  it("a joined request never reloads when /api/ps reports another context than the fit settled on", async () => {
    // The fit settles at 2048; this fake's /api/ps says 16384, so a queued second load reads the model as needing a reload.
    const generate = deferred();
    const ps: string[] = [];
    const s = await fakeOllama(ps, [], {
      "POST /api/generate": async (b, res) => {
        await generate.promise;
        const model = (b as { model: string }).model;
        ps.push(model);
        json(res, 200, { model, response: "", done: true });
      },
    });
    const pushes: ModelLoad[] = [];
    const loader = loaderFor(s, pushes, "fits", { fit: async () => ({ ...report("fits"), numCtx: 2048 }) });
    const first = loader.load("gemma4:12b", 16384);
    await until(() => generates(s) === 1);
    const second = loader.load("gemma4:12b", 16384);
    generate.release();
    await Promise.all([first, second]);
    expect(pushes.map((p) => p.state)).toEqual(["loading", "ready"]);
    expect(generates(s)).toBe(1);
  });

  it("a request for a loading model at another context is its own load, after the first", async () => {
    const pushes: ModelLoad[] = [];
    const s = await fakeOllama([]);
    const loader = loaderFor(s, pushes);
    const [a, b] = await Promise.all([loader.load("m:7b", 16384), loader.load("m:7b", 32768)]);
    expect([a.numCtx, b.numCtx]).toEqual([16384, 32768]);
    expect(generates(s)).toBe(2);
  });

  it("a request after a runtime change never joins a load still settling from the old runtime: it is a load of its own", async () => {
    const a = await fakeOllama([]);
    const b = await fakeOllama([]);
    let url = a.baseUrl;
    const fitHeld = deferred();
    let fits = 0;
    const pushes: ModelLoad[] = [];
    const loader = loaderFor(a, pushes, "fits", {
      baseUrl: () => url,
      fit: async (_m, numCtx) => {
        if (++fits === 1) await fitHeld.promise;
        return { ...report("fits"), numCtx };
      },
    });
    const old = loader.load("gemma4:12b", 16384);
    await until(() => fits === 1);
    loader.runtimeChanged();
    url = b.baseUrl;
    loader.runtimeSettled();
    // The old load is still in its fit, so it has not ended yet.
    const fresh = loader.load("gemma4:12b", 16384);
    fitHeld.release();
    expect(await old).toMatchObject({ state: "error", message: CHANGED });
    expect(await fresh).toEqual({ model: "gemma4:12b", numCtx: 16384, state: "ready" });
    expect(generates(a)).toBe(0);
    expect(generates(b)).toBe(1);
  });

  it("a load that ends never drops a newer load's place: a later request at that load's context still joins it", async () => {
    const holds = [deferred(), deferred()];
    let g = 0;
    const ps: string[] = [];
    const s = await fakeOllama(ps, [], {
      "POST /api/generate": async (body, res) => {
        await holds[g++]?.promise;
        const model = (body as { model: string }).model;
        ps.push(model);
        json(res, 200, { model, response: "", done: true });
      },
    });
    const pushes: ModelLoad[] = [];
    const loader = loaderFor(s, pushes);
    const at16 = loader.load("gemma4:12b", 16384);
    await until(() => generates(s) === 1);
    const at32 = loader.load("gemma4:12b", 32768); // its own load, queued behind the 16k one
    holds[0]?.release();
    await at16;
    const later = loader.load("gemma4:12b", 32768); // the 16k load has ended; the 32k one has not
    await until(() => generates(s) === 2);
    holds[1]?.release();
    const [x, y] = await Promise.all([at32, later]);
    expect(y).toEqual(x);
    expect(s.requests.filter((r) => r.path === "/api/ps")).toHaveLength(2);
    expect(generates(s)).toBe(2);
    expect(pushes.map((p) => `${p.numCtx}:${p.state}`)).toEqual(["16384:loading", "16384:ready", "32768:loading", "32768:ready"]);
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

/** A loader whose /api/ps fails with `failure()` (or answers empty when it gives undefined); its log lines about /api/ps. */
function quiet(failure: () => string | undefined) {
  const lines: string[] = [];
  const loader = createModelLoader({
    baseUrl: () => "http://127.0.0.1:1",
    push: () => undefined,
    listLoaded: async () => {
      const message = failure();
      if (message !== undefined) throw new Error(message);
      return [];
    },
    fit: async (_model, numCtx) => ({ ...report("fits"), numCtx }),
    log: (line) => lines.push(line),
  });
  return { loader, logged: () => lines.filter((l) => l.includes("/api/ps")) };
}

describe("the GPU poll's /api/ps failures are logged quietly", () => {
  it("ten failing polls in a row log one line", async () => {
    const { loader, logged } = quiet(() => "connection refused");
    for (let i = 0; i < 10; i++) expect(await loader.residentModels()).toEqual([]);
    expect(logged()).toEqual(["reading /api/ps failed: connection refused"]);
  });

  it("a success, or a different message, logs the next failure again", async () => {
    const answers: (string | undefined)[] = ["connection refused", "connection refused", undefined, "connection refused", "timed out", "timed out"];
    const { loader, logged } = quiet(() => answers.shift());
    for (let i = 0; i < 6; i++) await loader.residentModels();
    expect(logged()).toEqual(["reading /api/ps failed: connection refused", "reading /api/ps failed: connection refused", "reading /api/ps failed: timed out"]);
  });

  it("a poll read cancelled by a switch logs nothing", async () => {
    const lines: string[] = [];
    const loader = createModelLoader({
      baseUrl: () => "http://127.0.0.1:1",
      push: () => undefined,
      listLoaded: (_url, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("This operation was aborted")), { once: true })),
      fit: async (_model, numCtx) => ({ ...report("fits"), numCtx }),
      log: (line) => lines.push(line),
    });
    const reading = loader.residentModels();
    await tick();
    loader.runtimeChanged();
    expect(await reading).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("a load's failed read still logs every time, beside a quiet poll", async () => {
    const { loader, logged } = quiet(() => "connection refused");
    await loader.residentModels();
    await loader.residentModels();
    for (let i = 0; i < 3; i++) expect(await loader.load("m", 16384)).toMatchObject({ state: "error" });
    expect(logged()).toHaveLength(4);
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
    loader.runtimeSettled();
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

  it("a GPU-poll reading of A that answers after the switch prunes nothing and reads as empty", async () => {
    const a = await fakeOllama(["old:7b"]);
    const b = await fakeOllama([]);
    let url = a.baseUrl;
    const held = deferred();
    const pushes: ModelLoad[] = [];
    // A read that ignores its abort, so only the generation decides.
    const loader = loaderFor(b, pushes, "fits", {
      baseUrl: () => url,
      listLoaded: async (u) => {
        const ps = await listLoaded(u);
        if (u === a.baseUrl) await held.promise;
        return ps;
      },
    });
    const reading = loader.residentModels();
    await tick();
    loader.runtimeChanged();
    url = b.baseUrl;
    loader.runtimeSettled();
    await loader.load("m", 16384);
    held.release();
    expect(await reading).toEqual([]);
    expect(loader.appLoadedModels()).toEqual(["m:latest"]);
    expect(pushes.filter((p) => p.state === "unloaded")).toEqual([]);
    // B's own reading prunes as before.
    expect((await loader.residentModels()).map((m) => m.name)).toEqual(["m"]);
    expect(loader.appLoadedModels()).toEqual(["m:latest"]);
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
    expect(r.message).toBe(CHANGED);
    expect(pushes.map((p) => p.state)).toEqual(["loading", "error"]);
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settled<T>(p: Promise<T>, what: string, ms = 20_000): Promise<unknown> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then((v) => ({ resolved: v }), (e: unknown) => e),
      new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), ms); }),
    ]);
  } finally { clearTimeout(deadline); }
}
const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e;
  }
};
const psWith = (models: { name: string; context_length?: number }[]): Route => (_b, res) =>
  json(res, 200, { models: models.map((m) => ({ size: 1, size_vram: 1, ...m })) });
const UNREADABLE = "Could not read which models Ollama has loaded, so the app did not load this one. Try again.";
const SWITCHING = "The runtime is changing. Try again in a moment.";
const CHANGED = "The runtime changed while this model was loading.";

describe("S-01: unknown residency fails closed", () => {
  it("a preload with an unreadable /api/ps refuses: no generate, nothing owned, and a later reading does not repair it", async () => {
    let failing = true;
    // m is someone else's, resident all along; only the first reading fails.
    const s = await fakeOllama([], [], {
      "GET /api/ps": (b, res, req) => (failing ? json(res, 500, { error: "transient" }) : psWith([{ name: "m:latest" }])(b, res, req)),
    });
    const pushes: ModelLoad[] = [];
    const loader = loaderFor(s, pushes);
    const r = await loader.load("m", 16384);
    expect(r).toEqual({ model: "m", numCtx: 16384, state: "error", message: UNREADABLE });
    expect(generates(s)).toBe(0);
    failing = false;
    loader.prune(["m:latest"]);
    expect(loader.appLoadedModels()).toEqual([]);
  });

  it("a turn with an unreadable /api/ps runs, claims nothing, and holds the gate until its first token", async () => {
    const s = await fakeOllama([], [], { "GET /api/ps": (_b, res) => json(res, 500, { error: "transient" }) });
    const pushes: ModelLoad[] = [];
    const loader = loaderFor(s, pushes);
    const a = loader.reserve("a:7b");
    expect((await a.admit(16384)).verdict).toBe("fits");
    const started: string[] = [];
    const b = loader.reserve("b:7b");
    const admittedB = b.admit(16384, { fit: async () => (started.push("b"), report("fits")) });
    await sleep(50);
    expect(started).toEqual([]);
    a.firstToken();
    await admittedB;
    expect(started).toEqual(["b"]);
    b.firstToken();
    a.end();
    b.end();
    await tick();
    expect(loader.appLoadedModels()).toEqual([]);
    expect(pushes).toEqual([]);
  });
});

describe("S-02: one runtime identity per load", () => {
  it("a load or a reservation started while the switch runs refuses; nothing reaches the old runtime", async () => {
    const a = await fakeOllama([]);
    const loader = loaderFor(a, []);
    // The switch began: the old runtime is still stopping and baseUrl() still answers A.
    loader.runtimeChanged();
    const r = await loader.load("m", 16384).catch((e: unknown) => e);
    expect(r).toBeInstanceOf(ModelActionError);
    expect(r).toMatchObject({ code: "runtime-switching", message: SWITCHING });
    expect(thrown(() => loader.reserve("m"))).toMatchObject({ code: "runtime-switching", message: SWITCHING });
    expect(a.requests).toEqual([]);
    expect(loader.appLoadedModels()).toEqual([]);
    // Once the new runtime's ensure settles, work starts again.
    loader.runtimeSettled();
    expect((await loader.load("m", 16384)).state).toBe("ready");
  });

  it("a preload suspended in its residency read, or in its fit, sends nothing after the switch", async () => {
    for (const where of ["residency", "fit"] as const) {
      const hold = deferred();
      const a = await fakeOllama([], [], {
        "GET /api/ps": async (b, res, req) => {
          if (where === "residency") await hold.promise;
          psWith([])(b, res, req);
        },
      });
      const pushes: ModelLoad[] = [];
      let fits = 0;
      const loader = loaderFor(a, pushes, "fits", {
        fit: async () => {
          fits++;
          if (where === "fit") await hold.promise;
          return report("fits");
        },
      });
      const pending = loader.load("m", 16384);
      await until(() => (where === "residency" ? a.requests.some((r) => r.path === "/api/ps") : fits === 1));
      loader.runtimeChanged();
      hold.release();
      const r = await pending;
      expect(r.state).toBe("error");
      expect(generates(a)).toBe(0);
      expect(fits).toBe(where === "fit" ? 1 : 0);
      expect(loader.appLoadedModels()).toEqual([]);
    }
  });

  it("an old turn's admit after the switch rejects, and a pending one rejects at the switch", async () => {
    const s = await fakeOllama([]);
    const loader = loaderFor(s, []);
    const old = loader.reserve("m");
    const holder = loader.reserve("a:7b");
    await holder.admit(16384); // cold: holds the gate until its first token
    const waiting = loader.reserve("b:7b");
    const pending = waiting.admit(16384);
    loader.runtimeChanged();
    expect(await settled(pending, "model admission")).toMatchObject({ code: "runtime-switching" });
    loader.runtimeSettled();
    expect(await settled(old.admit(16384), "model admission")).toMatchObject({ code: "runtime-switching" });
    expect(loader.inUse("m")).toBe(false);
    expect(loader.inUse("b:7b")).toBe(false);
    holder.end();
  });
});

describe("S-03: the gate stays held unless residency and context are proven", () => {
  it("two turns on a resident model at a different num_ctx run their fits one after the other", async () => {
    const s = await fakeOllama([], [], { "GET /api/ps": psWith([{ name: "m:latest", context_length: 4096 }]) });
    const loader = loaderFor(s, []);
    const started: string[] = [];
    const fit = (name: string) => async () => (started.push(name), report("fits"));
    const a = loader.reserve("m");
    const b = loader.reserve("m");
    await a.admit(16384, { fit: fit("a") });
    const admittedB = b.admit(16384, { fit: fit("b") });
    await sleep(50);
    // a may reload m at 16384: b measures only after a answered.
    expect(started).toEqual(["a"]);
    a.firstToken();
    await admittedB;
    expect(started).toEqual(["a", "b"]);
    b.firstToken();
    a.end();
    b.end();
  });

  it("a resident model whose /api/ps context matches releases the gate after its fit", async () => {
    const s = await fakeOllama([], [], { "GET /api/ps": psWith([{ name: "m:latest", context_length: 16384 }]) });
    const loader = loaderFor(s, []);
    const a = loader.reserve("m");
    await a.admit(16384);
    const started: string[] = [];
    const b = loader.reserve("m");
    await b.admit(16384, { fit: async () => (started.push("b"), report("fits")) });
    expect(started).toEqual(["b"]);
    a.end();
    b.end();
  });
});

describe("R2-01: a resident model's measured memory counts only at its proven context", () => {
  const SHOW_9B = JSON.parse(readFileSync(new URL("../fit/fixtures/show-qwen3-5-9b.json", import.meta.url), "utf8")) as unknown;
  /** The real loader and the real fit check over a fake Ollama, a full GPU and no free RAM. */
  async function fullMachine(contextLength: number | undefined) {
    // Wholly on the GPU: it holds at least its 6.6 GB of weights there, so its measurement counts.
    const entry = { name: "qwen3.5:9b", size: 7 * GB, size_vram: 7 * GB, ...(contextLength === undefined ? {} : { context_length: contextLength }) };
    const s = await startFakeServer({
      "GET /api/ps": (_b, res) => json(res, 200, { models: [entry] }),
      "GET /api/tags": (_b, res) => json(res, 200, { models: [{ name: "qwen3.5:9b", size: 6594474711, digest: "a", modified_at: "2026-11-01T00:00:00Z" }] }),
      "POST /api/show": (_b, res) => json(res, 200, SHOW_9B),
      "POST /api/generate": (b, res) => json(res, 200, { model: (b as { model: string }).model, response: "", done: true }),
    });
    servers.push(s);
    const machine = {
      runNvidiaSmi: async (args: readonly string[]) => (args[0]?.startsWith("--query-gpu") ? "16303, 16303, 0\n" : ""),
      readMeminfo: async () => "MemAvailable: 0 kB\n",
    };
    const loader = loaderFor(s, [], "fits", { fit: async (model, numCtx, baseUrl) => (await checkFit({ ...machine, baseUrl, model, numCtx })).report });
    return { s, loader };
  }

  it("an /api/ps without context_length (older Ollama) is estimated at the requested num_ctx, so 64k refuses", async () => {
    const { loader } = await fullMachine(undefined);
    const turn = loader.reserve("qwen3.5:9b");
    const r = await turn.admit(65536);
    expect(r).toMatchObject({ verdict: "refuse", source: "estimate", numCtx: 65536 });
    expect(loader.inUse("qwen3.5:9b")).toBe(false);
  });

  it("a resident model at another context is estimated too; the same context keeps its measured fit", async () => {
    const other = await fullMachine(4096);
    expect(await other.loader.reserve("qwen3.5:9b").admit(65536)).toMatchObject({ verdict: "refuse", source: "estimate" });
    const same = await fullMachine(65536);
    const turn = same.loader.reserve("qwen3.5:9b");
    expect(await turn.admit(65536)).toMatchObject({ verdict: "fits", source: "measured" });
    turn.end();
  });
});

describe("S-05: preloads reserve their model", () => {
  it("while a preload waits in its fit, models.remove refuses", async () => {
    const hold = deferred();
    const s = await fakeOllama([]);
    const loader = loaderFor(s, [], "fits", {
      fit: async () => {
        await hold.promise;
        return report("fits");
      },
    });
    const loading = loader.load("m", 16384);
    await until(() => loader.inUse("m"));
    expect(loader.inUse("m")).toBe(true);
    expect(thrown(() => loader.beginRemove("m"))).toMatchObject({ code: "model-in-use" });
    hold.release();
    expect((await loading).state).toBe("ready");
    expect(loader.inUse("m")).toBe(false);
  });

  it("a preload queued behind the gate keeps its model reserved, so no removal runs beneath it", async () => {
    const s = await fakeOllama([]);
    const loader = loaderFor(s, []);
    const holder = loader.reserve("a:7b");
    await holder.admit(16384); // cold: holds the gate
    const loading = loader.load("m", 16384);
    expect(thrown(() => loader.beginRemove("m"))).toMatchObject({ code: "model-in-use" });
    holder.end();
    expect((await loading).state).toBe("ready");
  });
});

describe("S-06: every loading notice ends exactly once", () => {
  it("a cold turn's loading ends with an error when a switch invalidates it; first token and end push nothing more", async () => {
    const s = await fakeOllama([]);
    const pushes: ModelLoad[] = [];
    const loader = loaderFor(s, pushes);
    const turn = loader.reserve("m");
    await turn.admit(16384);
    loader.runtimeChanged();
    turn.firstToken();
    turn.end();
    await sleep(30);
    expect(pushes).toEqual([
      { model: "m", numCtx: 16384, state: "loading" },
      { model: "m", numCtx: 16384, state: "error", message: CHANGED },
    ]);
  });

  it("a preload's loading ends once when the switch lands during /api/generate", async () => {
    const hold = deferred();
    const s = await fakeOllama([], [], {
      "POST /api/generate": async (b, res) => {
        await hold.promise;
        json(res, 200, { model: (b as { model: string }).model, response: "", done: true });
      },
    });
    const pushes: ModelLoad[] = [];
    const loader = loaderFor(s, pushes);
    const pending = loader.load("m", 16384);
    await until(() => generates(s) === 1);
    loader.runtimeChanged();
    hold.release();
    expect(await pending).toMatchObject({ state: "error", message: CHANGED });
    expect(pushes.map((p) => p.state)).toEqual(["loading", "error"]);
  });
});

describe("I-04: loads drain before the image module closes", () => {
  it("shutdown aborts a slow preload in its generate stage, so the real image close stops ComfyUI once and leaves the lease empty", async () => {
    const aborted = deferred();
    const s = await fakeOllama([], [], {
      // Ten minutes of cold load, cut short only by the client going away.
      "POST /api/generate": (_b, res) => new Promise<void>((r) => res.on("close", () => { aborted.release(); r(); })),
    });
    const lease = createGpuLease();
    // The real image module, owning an idle ComfyUI it started (injected service and HTTP fakes).
    const dir = mkdtempSync(path.join(os.tmpdir(), "gates-local-i04-"));
    const comfy = await ownedIdleComfy(lease, dir);
    const pushes: ModelLoad[] = [];
    const loader = loaderFor(s, pushes, "fits", { lease });
    const loading = loader.load("m", 16384);
    await until(() => generates(s) === 1);
    expect(lease.status()).toMatchObject({ holder: "chat", holders: 1 });
    // main.ts: cancel turns, drain model loads, close image module (image.close()'s stopIdle claims the GPU alone).
    const shutdown = async () => {
      await (loader as Partial<Pick<ModelLoader, "close">>).close?.();
      await comfy.image.close();
    };
    try {
      const closing = shutdown();
      expect(await settled(aborted.promise, "shutdown aborting the preload socket", 2000)).toEqual({ resolved: undefined });
      expect(await settled(closing, "application shutdown")).toEqual({ resolved: undefined });
      expect(comfy.stops()).toBe(1);
      expect(lease.status()).toEqual({ holder: null, holders: 0, waiting: [] });
    } finally {
      comfy.close();
      rmSync(dir, { recursive: true, force: true });
    }
    expect((await loading).state).toBe("error");
    expect(pushes.map((p) => p.state)).toEqual(["loading", "error"]);
    // Closed: no new load or turn.
    expect(await loader.load("n", 16384).catch((e: unknown) => e)).toMatchObject({ code: "shutting-down" });
    expect(thrown(() => loader.reserve("n"))).toMatchObject({ code: "shutting-down" });
  });

  it("a preload still waiting for its GPU claim is aborted by close() too", async () => {
    const s = await fakeOllama([]);
    const lease = createGpuLease();
    const releaseImage = await lease.acquire("image");
    const loader = loaderFor(s, [], "fits", { lease });
    const queued = loader.load("m", 16384);
    await until(() => lease.status().waiting.includes("chat"));
    const drained = (async () => {
      await (loader as Partial<Pick<ModelLoader, "close">>).close?.();
      return queued;
    })();
    expect(await settled(drained, "model loader shutdown")).toMatchObject({ resolved: { state: "error" } });
    expect(lease.status()).toEqual({ holder: "image", holders: 1, waiting: [] });
    expect(s.requests).toEqual([]);
    releaseImage();
  });
});

describe("models.remove", () => {
  it("refuses while a turn holds the model, otherwise deletes and refreshes the list", async () => {
    const tags = ["qwen3.5:9b", "gemma4:12b"];
    const s = await fakeOllama([], tags);
    const loader = loaderFor(s, []);
    const catalog = createModelCatalog(() => s.baseUrl, { minIntervalMs: 60_000, retryMs: 0 }); // not about retries (MP2-04)
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
