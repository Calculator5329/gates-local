// session.ts wired to a fake client: the order of model-list answers and
// pushes (MP2-02) and which chat follows the server's pick (MP-02). The
// module touches window at load, so each test stubs the browser globals and
// imports a fresh copy. Kept apart from session.test.ts, whose discovery
// tests need the real createClient this file mocks.
import type { ModelInfo } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock("@gates-local/contracts", async (orig) => ({ ...(await orig<typeof import("@gates-local/contracts")>()), createClient: () => fake.client }));

const noop = () => undefined;
const defer = <T>() => {
  let resolve: (v: T) => void = noop;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve: (v: T) => resolve(v) };
};

const info = (name: string, picked = false): ModelInfo => ({
  name,
  digest: name,
  sizeBytes: 1,
  modifiedAt: "",
  capabilities: ["completion"],
  ...(picked ? { pick: { numCtx: 16384, verdict: "fits" as const } } : {}),
});
const QWEN = "qwen3.5:9b";
const GEMMA = "gemma4:12b";
const LLAMA = "llama3.2:3b";

const defaults: Record<string, unknown> = {
  "runtime.status": { state: "ready", owner: "external", version: "0.12.0" },
  "models.list": [info(QWEN), info(GEMMA), info(LLAMA, true)],
  "threads.list": [{ id: "A", title: "A", createdAt: 1, updatedAt: 1 }],
  "threads.get": { messages: [] },
  "settings.get": { theme: "system", defaultNumCtx: 16384, thinking: true, imageGen: false },
};

class FakeSocket extends EventTarget {
  constructor() {
    super();
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
}

/** Boots session.ts against a client whose answers the test may hold; returns the session, the store and a push. */
async function boot(answers: Record<string, () => Promise<unknown>> = {}, connections: Promise<void>[] = []) {
  const subs = new Map<string, (p: unknown) => void>();
  const calls: string[] = [];
  fake.client = {
    get closed() {
      return connections.shift() ?? new Promise(noop);
    },
    subscribe: (channel: string, handler: (p: unknown) => void) => {
      subs.set(channel, handler);
      return noop;
    },
    call: (method: string) => {
      calls.push(method);
      return answers[method]?.() ?? Promise.resolve(defaults[method]);
    },
  };
  vi.stubGlobal("window", {});
  vi.stubGlobal("location", { search: "?server=ws://localhost:1", hash: "", pathname: "/" });
  vi.stubGlobal("history", { replaceState: noop });
  vi.stubGlobal("document", { querySelector: () => null, documentElement: { removeAttribute: noop, setAttribute: noop } });
  vi.stubGlobal("localStorage", { getItem: () => "1", setItem: noop });
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.resetModules();
  const session = await import("./session.ts");
  const store = await import("./store.ts");
  session.connect();
  await vi.waitFor(() => expect(subs.has("models.changed")).toBe(true));
  const push = (channel: string, payload: unknown) => subs.get(channel)?.(payload);
  // threads.list is answered in hydration's first batch, so its threads mark that batch as applied.
  const hydrated = () => vi.waitFor(() => expect(store.getState().threads).toHaveLength(1));
  return { session, store, push, calls, hydrated };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("a models.list answered after a newer models.changed push is dropped (MP2-02)", async () => {
  const list = defer<ModelInfo[]>();
  const { store, push, hydrated } = await boot({ "models.list": () => list.promise });
  push("models.changed", [info(GEMMA, true)]);
  list.resolve([info(QWEN, true)]);
  await hydrated();
  expect(store.getState().models?.map((m) => m.name)).toEqual([GEMMA]);
  expect(store.getState().model).toBe(GEMMA);
});

it("hydration answers older than a runtime change keep neither the old list nor the old runtime status (MP2-02, MP4-03)", async () => {
  const list = defer<ModelInfo[]>();
  const { store, push, calls, hydrated } = await boot({ "models.list": () => list.promise, "models.refresh": async () => [info(GEMMA, true)] });
  // hydration's runtime.status answered for runtime A (0.12.0); the push is newer: runtime B
  push("runtime.changed", { state: "ready", owner: "external", baseUrl: "http://runtime-b", version: "0.40.4" });
  list.resolve([info(QWEN, true)]);
  await hydrated();
  await vi.waitFor(() => expect(store.getState().models?.map((m) => m.name)).toEqual([GEMMA]));
  expect(calls).toContain("models.refresh");
  expect(store.getState().runtime).toMatchObject({ state: "ready", baseUrl: "http://runtime-b", version: "0.40.4" });
});

it("a catalog asked before a later models.changed never lands over the newer one", async () => {
  const sample = methodSamples["models.catalog"].result;
  const stale = sample.map((c) => ({ ...c, installed: true }));
  const fresh = sample.map((c) => ({ ...c, installed: false }));
  const answers = [defer<unknown>(), defer<unknown>()];
  let asked = 0;
  const { store, push, calls, hydrated } = await boot({ "models.catalog": () => answers[asked++]?.promise ?? Promise.resolve(fresh) });
  await hydrated();
  // hydration's catalog probe is in flight; a removal pushes a new list, which asks again
  await vi.waitFor(() => expect(calls.filter((m) => m === "models.catalog")).toHaveLength(1));
  push("models.changed", [info(LLAMA, true)]);
  await vi.waitFor(() => expect(calls.filter((m) => m === "models.catalog")).toHaveLength(2));
  answers[1]?.resolve(fresh);
  await vi.waitFor(() => expect(store.getState().catalog).toEqual(fresh));
  answers[0]?.resolve(stale);
  await new Promise((r) => setTimeout(r, 20));
  expect(store.getState().catalog).toEqual(fresh);
});

it("a thread keeps its model when the pick changes; only a new empty chat follows the pick (MP-02)", async () => {
  const { session, store, push, hydrated } = await boot();
  await hydrated();
  const model = () => store.getState().model;
  expect(model()).toBe(LLAMA);
  session.openThread("A");
  session.pickModel(GEMMA);
  session.newThread();
  expect(model()).toBe(LLAMA); // the new chat starts on the pick
  session.openThread("A");
  expect(model()).toBe(GEMMA); // A is back on the model picked in it
  push("models.changed", [info(QWEN, true), info(GEMMA), info(LLAMA)]);
  expect(model()).toBe(GEMMA); // a recommendation never moves a thread
  session.newThread();
  expect(model()).toBe(QWEN); // the new, empty chat follows it
});

const savedReply = (model: string) => ({ messages: [{ id: "m1", role: "assistant", model, content: "Saved answer", createdAt: 1 }] });
const qwenPicked = [info(QWEN, true), info(GEMMA), info(LLAMA)];

describe("a thread restored from storage takes the model of its latest saved reply (MP4-04)", () => {
  it("opens on that model and records it as the thread's", async () => {
    const { session, store, hydrated } = await boot({ "models.list": async () => qwenPicked, "threads.get": async () => savedReply(GEMMA) });
    await hydrated();
    expect(store.getState().model).toBe(QWEN);
    session.openThread("S");
    await vi.waitFor(() => expect(store.getState().model).toBe(GEMMA));
    expect(store.getState().threadModels["S"]).toBe(GEMMA);
  });

  it("an unsent pick made in the thread before its history loads wins", async () => {
    const history = defer<unknown>();
    const { session, store, hydrated } = await boot({ "models.list": async () => qwenPicked, "threads.get": () => history.promise });
    await hydrated();
    session.openThread("S");
    session.pickModel(QWEN);
    history.resolve(savedReply(GEMMA));
    await vi.waitFor(() => expect(store.getState().messages["S"]).toBeDefined());
    expect(store.getState().model).toBe(QWEN);
    expect(store.getState().threadModels["S"]).toBe(QWEN);
  });

  it("a saved model no longer installed is not taken or recorded", async () => {
    const { session, store, hydrated } = await boot({ "models.list": async () => qwenPicked, "threads.get": async () => savedReply("gone:1b") });
    await hydrated();
    session.openThread("S");
    await vi.waitFor(() => expect(store.getState().messages["S"]).toBeDefined());
    expect(store.getState().model).toBe(QWEN);
    expect(store.getState().threadModels["S"]).not.toBe("gone:1b");
  });
});

it("a deleted thread, or one a refresh no longer lists, leaves no threadModels entry (MP4-05)", async () => {
  const answers: Record<string, () => Promise<unknown>> = {};
  const { session, store, push, hydrated } = await boot(answers);
  await hydrated();
  session.openThread("A");
  session.pickModel(GEMMA);
  session.openThread("B");
  session.pickModel(QWEN);
  expect(Object.keys(store.getState().threadModels).toSorted()).toEqual(["A", "B"]);
  await session.deleteThread("A");
  expect(Object.keys(store.getState().threadModels)).toEqual(["B"]);
  answers["threads.list"] = async () => [];
  push("threads.changed", {});
  await vi.waitFor(() => expect(store.getState().threadModels).toEqual({}));
});

const thread = (id: string) => ({ id, title: id, createdAt: 1, updatedAt: 1 });
const settle = () => new Promise((r) => setTimeout(r, 20));
const failing = async () => {
  throw new Error("discovery pending");
};

describe("a threads.list answer older than a newer list or a local change is dropped (MP5-01)", () => {
  it("an older list that lacks the thread neither drops it nor its unsent pick", async () => {
    const old = defer<unknown>();
    const answers: Record<string, () => Promise<unknown>> = {};
    const { session, store, push, hydrated } = await boot(answers);
    await hydrated();
    answers["threads.list"] = () => old.promise;
    push("threads.changed", {});
    answers["threads.list"] = async () => [thread("S")];
    push("threads.changed", {});
    await vi.waitFor(() => expect(store.getState().threads.map((t) => t.id)).toEqual(["S"]));
    session.openThread("S");
    session.pickModel(QWEN);
    old.resolve([]);
    await settle();
    expect(store.getState().threads.map((t) => t.id)).toEqual(["S"]);
    expect(store.getState().threadModels["S"]).toBe(QWEN);
    // the saved history (a Gemma reply) loads again: the unsent pick still wins
    answers["threads.get"] = async () => savedReply(GEMMA);
    session.reloadThread("S");
    await vi.waitFor(() => expect(store.getState().messages["S"]?.[0]?.model).toBe(GEMMA));
    session.openThread("S");
    expect(store.getState().model).toBe(QWEN);
  });

  it("a list asked before a local delete does not bring the thread back", async () => {
    const old = defer<unknown>();
    const answers: Record<string, () => Promise<unknown>> = {};
    const { session, store, push, hydrated } = await boot(answers);
    await hydrated();
    answers["threads.list"] = () => old.promise;
    push("threads.changed", {});
    await session.deleteThread("A");
    old.resolve([thread("A")]);
    await settle();
    expect(store.getState().threads).toEqual([]);
  });
});

describe("a saved model is restored once a model list arrives after the history (MP5-02)", () => {

  it("restores it when the first list lands", async () => {
    const { session, store, push, hydrated } = await boot({ "models.list": failing, "threads.get": async () => savedReply(GEMMA) });
    await hydrated();
    session.openThread("S");
    await vi.waitFor(() => expect(store.getState().messages["S"]).toBeDefined());
    push("models.changed", qwenPicked);
    expect(store.getState().model).toBe(GEMMA);
    expect(store.getState().threadModels["S"]).toBe(GEMMA);
  });

  it("an in-session pick made before the list lands still wins", async () => {
    const { session, store, push, hydrated } = await boot({ "models.list": failing, "threads.get": async () => savedReply(GEMMA) });
    await hydrated();
    session.openThread("S");
    await vi.waitFor(() => expect(store.getState().messages["S"]).toBeDefined());
    session.pickModel(LLAMA);
    push("models.changed", qwenPicked);
    expect(store.getState().model).toBe(LLAMA);
    expect(store.getState().threadModels["S"]).toBe(LLAMA);
  });

  it("a fallback the person never chose is not recorded as the thread's", async () => {
    const { session, store, push, hydrated } = await boot({ "models.list": failing, "threads.get": async () => savedReply("gone:1b") });
    await hydrated();
    session.openThread("S");
    await vi.waitFor(() => expect(store.getState().messages["S"]).toBeDefined());
    push("models.changed", qwenPicked);
    expect(store.getState().model).toBe(QWEN);
    expect(store.getState().threadModels["S"]).toBeUndefined();
  });
});

it("a saved model that is installed but now only embeds is not restored (MP5-03)", async () => {
  const embedding: ModelInfo = { ...info(GEMMA), capabilities: ["embedding"] };
  const { session, store, hydrated } = await boot({ "models.list": async () => [info(QWEN, true), embedding], "threads.get": async () => savedReply(GEMMA) });
  await hydrated();
  session.openThread("S");
  await vi.waitFor(() => expect(store.getState().messages["S"]).toBeDefined());
  expect(store.getState().model).toBe(QWEN);
  expect(store.getState().threadModels["S"]).toBeUndefined();
});

describe("a catalog that has not landed yet (W1-02)", () => {
  const sample = methodSamples["models.catalog"].result;

  it("takes an older answer when the newer question failed", async () => {
    const first = defer<unknown>();
    let asked = 0;
    const { store, push, calls, hydrated } = await boot({ "models.catalog": () => (asked++ === 0 ? first.promise : Promise.reject(new Error("no answer"))) });
    await hydrated();
    await vi.waitFor(() => expect(calls.filter((m) => m === "models.catalog")).toHaveLength(1));
    push("models.changed", [info(LLAMA, true)]);
    await vi.waitFor(() => expect(calls.filter((m) => m === "models.catalog")).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 0));
    first.resolve(sample);
    await vi.waitFor(() => expect(store.getState().catalog).toEqual(sample));
  });

  it("asks again on the next model refresh when none ever arrived", async () => {
    let asked = 0;
    const { session, store, calls, hydrated } = await boot({ "models.refresh": async () => [info(LLAMA, true)], "models.catalog": () => (asked++ === 0 ? Promise.reject(new Error("no answer")) : Promise.resolve(sample)) });
    await hydrated();
    await vi.waitFor(() => expect(calls.filter((m) => m === "models.catalog")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));
    await session.refreshModels();
    await vi.waitFor(() => expect(store.getState().catalog).toEqual(sample));
  });
});

const settled = () => new Promise((r) => setTimeout(r, 20));

describe("Thinking at the start", () => {
  const noGpuAnswer = { "gpu.status": async () => ({ vendor: "none" }) };

  it("starts off on a computer with no supported GPU", async () => {
    const { store, calls, hydrated } = await boot(noGpuAnswer);
    await hydrated();
    await vi.waitFor(() => expect(calls).toContain("gpu.status"));
    await vi.waitFor(() => expect(store.getState().think).toBe(false));
  });

  it("stays on with a GPU", async () => {
    const { store, calls, hydrated } = await boot({ "gpu.status": async () => ({ vendor: "nvidia" }) });
    await hydrated();
    await vi.waitFor(() => expect(calls).toContain("gpu.status"));
    await settled();
    expect(store.getState().think).toBe(true);
  });

  it("stays on while the GPU cannot be read", async () => {
    const { store, calls, hydrated } = await boot({ "gpu.status": () => Promise.reject(new Error("no answer")) });
    await hydrated();
    await vi.waitFor(() => expect(calls).toContain("gpu.status"));
    await settled();
    expect(store.getState().think).toBe(true);
  });

  it.each([
    { answer: "nvidia", pushed: "none", think: false },
    { answer: "none", pushed: "nvidia", think: true },
  ])("a GPU push held behind a $answer answer ($pushed) decides it (R-02)", async ({ answer, pushed, think }) => {
    const catalog = defer<unknown>();
    const { store, push, calls, hydrated } = await boot({ "gpu.status": async () => ({ vendor: answer }), "models.catalog": () => catalog.promise });
    await hydrated();
    await vi.waitFor(() => expect(calls).toContain("models.catalog"));
    await settled();
    push("gpu.changed", { vendor: pushed });
    catalog.resolve(methodSamples["models.catalog"].result);
    await vi.waitFor(() => expect(store.getState().gpu).toEqual({ vendor: pushed }));
    await settled();
    expect(store.getState().think).toBe(think);
  });

  it("keeps the person's choice across a reconnect", async () => {
    const dropped = defer<void>();
    const { store, calls, hydrated } = await boot(noGpuAnswer, [dropped.promise]);
    await hydrated();
    await vi.waitFor(() => expect(store.getState().think).toBe(false));
    store.setState({ think: true });
    dropped.resolve();
    await vi.waitFor(() => expect(calls.filter((m) => m === "gpu.status")).toHaveLength(2), { timeout: 3000 });
    await settled();
    expect(store.getState().think).toBe(true);
  });
});
