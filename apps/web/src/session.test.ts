// session.ts wired to a fake client: the order of model-list answers and
// pushes (MP2-02) and which chat follows the server's pick (MP-02). The
// module touches window at load, so each test stubs the browser globals and
// imports a fresh copy.
import type { ModelInfo } from "@gates-local/contracts";
import { afterEach, expect, it, vi } from "vitest";

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
async function boot(answers: Record<string, () => Promise<unknown>> = {}) {
  const subs = new Map<string, (p: unknown) => void>();
  const calls: string[] = [];
  fake.client = {
    closed: new Promise(noop),
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
  vi.stubGlobal("document", { documentElement: { removeAttribute: noop, setAttribute: noop } });
  vi.stubGlobal("localStorage", { getItem: () => "1", setItem: noop });
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.resetModules();
  const session = await import("./session.ts");
  const store = await import("./store.ts");
  session.connect();
  await vi.waitFor(() => expect(subs.has("models.changed")).toBe(true));
  const push = (channel: string, payload: unknown) => subs.get(channel)?.(payload);
  const hydrated = () => vi.waitFor(() => expect(store.getState().runtime).toBeDefined());
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

it("a models.list asked before a runtime change is dropped, and the list is asked for again (MP2-02)", async () => {
  const list = defer<ModelInfo[]>();
  const { store, push, calls, hydrated } = await boot({ "models.list": () => list.promise, "models.refresh": async () => [info(GEMMA, true)] });
  push("runtime.changed", { state: "ready", owner: "external", version: "0.12.0" });
  list.resolve([info(QWEN, true)]);
  await hydrated();
  await vi.waitFor(() => expect(store.getState().models?.map((m) => m.name)).toEqual([GEMMA]));
  expect(calls).toContain("models.refresh");
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
