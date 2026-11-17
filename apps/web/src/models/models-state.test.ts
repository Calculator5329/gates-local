import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo, ModelSpeed, RuntimeStatus } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { installBrowser } from "../../test/harness.ts";
import { numberServer } from "../../test/numbered-server.ts";
import { drain } from "../../test/ordering-world.ts";

type Models = typeof import("./models.ts");
type Store = typeof import("../lib/store/store.ts");
type Speed = typeof import("./speed.ts");
type Effects = Parameters<Models["createModels"]>[0];
type Answer = (params: unknown) => Promise<unknown>;

const PICK: ModelInfo["pick"] = { numCtx: 16384, verdict: "fits" };
const info = (name: string, pick?: ModelInfo["pick"]): ModelInfo => ({
  name,
  digest: name,
  sizeBytes: 1,
  modifiedAt: "",
  capabilities: ["completion"],
  ...(pick === undefined ? {} : { pick }),
});
const QWEN = "qwen3.5:9b";
const GEMMA = "gemma4:12b";
const LLAMA = "llama3.2:3b";
const READY: RuntimeStatus = { state: "ready", owner: "external", baseUrl: "http://127.0.0.1:11434" };
const STOPPED: RuntimeStatus = { ...READY, state: "stopped" };
const NOT_IMPLEMENTED = new Error("not-implemented");

const noop = () => undefined;
const never = () => new Promise<never>(noop);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function defer() {
  let resolve: (value: unknown) => void = noop;
  let reject: (error: unknown) => void = noop;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** createModels against a fake server: each method answers from `answers`, an unlisted one never answers. */
function world(store: Store, answers: Record<string, Answer>, overrides: Partial<Effects> = {}) {
  const asked: { method: string; params: unknown }[] = [];
  const reply = (method: string, params: unknown): Promise<unknown> => {
    asked.push({ method, params });
    return answers[method]?.(params) ?? never();
  };
  const effects: Effects = {
    applyServerEvent: store.setState,
    call: async (method, params, options) => {
      const value = await reply(method, params);
      options?.onResult?.(value as never, undefined);
      return value as never;
    },
    probe: async (method, params) => (await reply(method, params)) as never,
    act: async (method, params) => {
      try {
        return { ok: true, value: (await reply(method, params)) as never };
      } catch {
        return { ok: false, message: `${method} failed` };
      }
    },
    isNA: (e) => e === NOT_IMPLEMENTED,
    restoreSaved: noop,
    blockingFor: async () => [],
    newer: () => true,
    ...overrides,
  };
  return { effects, asked, methods: () => asked.map((a) => a.method) };
}

let models: Models;
let store: Store;
let speed: Speed;

const typingReady = () => store.setState({ conn: { kind: "open" }, runtime: READY, models: [info(QWEN, PICK), info(GEMMA)], model: QWEN });
const loadAnswer: Record<string, Answer> = { "models.load": async (params) => ({ ...(params as object), state: "ready" }) };
const loadsAsked = (asked: readonly { method: string; params: unknown }[]) => asked.filter((a) => a.method === "models.load").map((a) => (a.params as { model: string }).model);

beforeEach(async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: noop });
  vi.resetModules();
  models = await import("./models.ts");
  store = await import("../lib/store/store.ts");
  speed = await import("./speed.ts");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a list answer", () => {
  it("a list refresh answered after a runtime push leaves the pushed runtime: only the newer one shows", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const browser = installBrowser();
    const server = numberServer(browser.server, { serves: ["settings", "sources", "updates", "models"] });
    vi.resetModules();
    const session = await import("../lib/session/index.ts");
    const fresh = await import("../lib/store/store.ts");
    const close = session.connect();
    for (let turn = 0; turn < 30 && fresh.getState().measures === undefined; turn++) await drain();
    const listed = methodSamples["models.list"].result;
    const ready: RuntimeStatus = methodSamples["runtime.status"].result;
    const first = listed.models[0];
    if (first === undefined) throw new Error("Missing model fixture");
    const grown = [...listed.models, { ...first, name: "added:7b" }];
    const reading = browser.server.hold("models.refresh");
    const asked = session.refreshModels();
    const slow = await reading;
    server.push("runtime.changed", { ...ready, state: "stopped" });
    await drain();
    slow.respond({ runtime: ready, models: grown });
    await asked;
    await drain();
    expect(fresh.getState().runtime?.state, "the pushed runtime stays").toBe("stopped");
    expect(fresh.getState().models?.map((m) => m.name), "the list's own number is newer, so the list applies").toEqual(grown.map((m) => m.name));
    close();
  });

  it("a refresh answered beside a runtime that is not ready keeps the list the store had", async () => {
    store.setState({ runtime: READY, models: [info(QWEN, PICK), info(GEMMA)], model: QWEN });
    const { effects } = world(store, { "models.refresh": async () => ({ runtime: STOPPED, models: [] }) });
    await models.createModels(effects).refreshModels();
    expect(store.getState().runtime?.state).toBe("stopped");
    expect(store.getState().models?.map((m) => m.name)).toEqual([QWEN, GEMMA]);
  });

  it("after a refresh answer the model is chosen again once the chats' saved models are back: the open chat lands on its own", async () => {
    store.setState({ runtime: READY, threadId: "T", model: undefined });
    const restoreSaved = () => store.setState((s) => ({ threadModels: { ...s.threadModels, T: GEMMA } }));
    const { effects } = world(store, { "models.refresh": async () => ({ runtime: READY, models: [info(QWEN, PICK), info(GEMMA)] }) }, { restoreSaved });
    await models.createModels(effects).refreshModels();
    expect(store.getState().model).toBe(GEMMA);
  });
});

describe("a new chat's model", () => {
  it("the chat model in memory is named as the installed list names it, either way round, and memory keeps its own name", () => {
    store.setState({ threadId: "T", memory: { resident: { kind: "chat", model: "qwen3.5" } }, models: [info("qwen3.5:latest"), info(GEMMA, PICK)], model: GEMMA });
    store.setState(models.newChatModel(store.getState()));
    expect(store.getState().newChatResident).toBe("qwen3.5");
    expect(store.getState().model).toBe("qwen3.5:latest");

    store.setState({ memory: { resident: { kind: "chat", model: "llama3.2:latest" } }, models: [info("llama3.2"), info(GEMMA, PICK)], model: GEMMA });
    store.setState(models.newChatModel(store.getState()));
    expect(store.getState().newChatResident).toBe("llama3.2:latest");
    expect(store.getState().model).toBe("llama3.2");
  });

  it("at New chat after memory has emptied, the chat starts on today's default, not the model memory held before", () => {
    store.setState({ threadId: "T", memory: {}, newChatResident: LLAMA, models: [info(LLAMA), info(QWEN, PICK)], model: LLAMA, chosen: undefined });
    store.setState(models.newChatModel(store.getState()));
    expect(store.getState().newChatResident).toBeUndefined();
    expect(store.getState().model).toBe(QWEN);
  });
});

describe("typing loads the model", () => {
  it("typing asks to load the same model again once a minute has passed, and not before", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.UTC(2026, 10, 16, 12);
    vi.setSystemTime(start);
    typingReady();
    const { effects, asked } = world(store, loadAnswer);
    const { typedInComposer } = models.createModels(effects);
    typedInComposer();
    await settle();
    expect(loadsAsked(asked)).toEqual([QWEN]);
    vi.setSystemTime(start + 59_999);
    typedInComposer();
    await settle();
    expect(loadsAsked(asked), "a key inside the minute asks nothing").toEqual([QWEN]);
    vi.setSystemTime(start + 60_000);
    typedInComposer();
    await settle();
    expect(loadsAsked(asked), "a key once the minute has passed asks again").toEqual([QWEN, QWEN]);
  });

  it("the typed-load time is kept per model: typing for one model, then switching and typing, asks for the other", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.UTC(2026, 10, 16, 12);
    vi.setSystemTime(start);
    typingReady();
    const { effects, asked } = world(store, loadAnswer);
    const { typedInComposer } = models.createModels(effects);
    typedInComposer();
    await settle();
    vi.setSystemTime(start + 1_000);
    store.setState({ model: GEMMA });
    typedInComposer();
    await settle();
    expect(loadsAsked(asked)).toEqual([QWEN, GEMMA]);
  });

  it("a pick from the picker says so, and a load asked by typing does not, so only a pick takes over a model someone else loaded", async () => {
    typingReady();
    const { effects, asked } = world(store, loadAnswer);
    const { typedInComposer, pickModel } = models.createModels(effects);
    typedInComposer();
    await settle();
    pickModel(GEMMA);
    await settle();
    expect(asked.filter((a) => a.method === "models.load").map((a) => a.params)).toEqual([
      { model: QWEN, numCtx: expect.any(Number) },
      { model: GEMMA, numCtx: expect.any(Number), pick: true },
    ]);
  });
});

describe("downloads", () => {
  it("a failed older pull does not remove the queued row a newer pull of the same model put there", async () => {
    const attempts = [defer(), defer()];
    const answers: Record<string, Answer> = { "models.pull": () => attempts.shift()?.promise ?? never() };
    const [older] = attempts;
    const { effects } = world(store, answers);
    const { pull } = models.createModels(effects);
    const first = pull(QWEN);
    void pull(QWEN);
    older?.reject(new Error("refused"));
    expect(await first).not.toBeNull();
    expect(store.getState().pulls[QWEN]).toMatchObject({ name: QWEN, state: "queued" });
  });

  it("a cancel that never reached the server leaves the download running and its row in place", async () => {
    const row = { name: QWEN, state: "downloading" as const, completedBytes: 5, totalBytes: 10 };
    store.setState({ pulls: { [QWEN]: row } });
    const { effects } = world(store, { "models.cancelPull": () => Promise.reject(new Error("socket closed")) });
    const said = await models.createModels(effects).cancelPull(QWEN);
    expect(said).not.toBeNull();
    expect(store.getState().pulls[QWEN]).toBe(row);
  });
});

describe("Retry from a runtime banner", () => {
  it("a server without runtime.retry answers its cached status instead", async () => {
    store.setState({ runtime: STOPPED });
    const status: RuntimeStatus = { ...READY, detail: "cached" };
    const { effects, methods } = world(store, {
      "runtime.retry": () => Promise.reject(NOT_IMPLEMENTED),
      "runtime.status": async () => status,
      "models.refresh": () => Promise.reject(new Error("not now")),
    });
    await models.createModels(effects).recheckRuntime();
    expect(methods().slice(0, 3)).toEqual(["runtime.retry", "runtime.status", "models.refresh"]);
    expect(store.getState().runtime).toEqual(status);
  });
});

describe("load timing", () => {
  it("a load's time runs from its first loading push to the ready that ends it", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.UTC(2026, 10, 16, 12);
    const { loadChanged } = models.createModels(world(store, {}).effects);
    vi.setSystemTime(start);
    loadChanged({ model: QWEN, numCtx: 16384, state: "loading" });
    vi.setSystemTime(start + 1_000);
    loadChanged({ model: QWEN, numCtx: 16384, state: "loading" });
    vi.setSystemTime(start + 5_000);
    loadChanged({ model: QWEN, numCtx: 16384, state: "ready" });
    expect(store.getState().loadTimes[QWEN]).toBe(5_000);
    expect(store.getState().loadSince[QWEN]).toBeUndefined();
  });

  it("only a ready that ends a load this client saw start records a time; any other end records nothing", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.UTC(2026, 10, 16, 12);
    const { loadChanged } = models.createModels(world(store, {}).effects);
    vi.setSystemTime(start);
    loadChanged({ model: QWEN, numCtx: 16384, state: "ready" });
    expect(store.getState().loadTimes[QWEN], "a ready with no start seen").toBeUndefined();
    loadChanged({ model: GEMMA, numCtx: 16384, state: "loading" });
    vi.setSystemTime(start + 2_000);
    loadChanged({ model: GEMMA, numCtx: 16384, state: "error", message: "out of memory" });
    expect(store.getState().loadTimes[GEMMA], "an error ends the timing").toBeUndefined();
    expect(store.getState().loadSince[GEMMA]).toBeUndefined();
    vi.setSystemTime(start + 4_000);
    loadChanged({ model: GEMMA, numCtx: 16384, state: "ready" });
    expect(store.getState().loadTimes[GEMMA], "a ready after the timing ended").toBeUndefined();
  });
});

describe("measured speeds", () => {
  it("a failed speed read leaves the speeds that were there", () => {
    const held: ModelSpeed = { model: QWEN, tokensPerSecond: 42, replies: 3 };
    store.setState({ speeds: { [QWEN]: held } });
    store.setState((s) => speed.speedsRead(s, undefined));
    const speeds = store.getState().speeds;
    expect(speeds === "na" ? undefined : speeds?.[QWEN]).toBe(held);
  });
});
