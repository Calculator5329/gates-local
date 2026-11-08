// The client session against an in-memory server (test/harness.ts): turn
// generations around Stop and Retry, the hydration order, reconnect
// reconciliation, the buffered words Stop keeps, runtime Retry and the
// failures actions hand back to the UI.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, Payload, RuntimeStatus } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { type Browser, installBrowser, tick, until } from "./harness.ts";

type Session = typeof import("../src/session.ts");
type Store = typeof import("../src/store.ts");

let b: Browser;
let session: Session;
let store: Store;

const READY: RuntimeStatus = methodSamples["runtime.status"].result;
const STARTING: RuntimeStatus = { state: "starting", owner: "app", baseUrl: "http://127.0.0.1:11435", detail: "Starting Ollama." };
const MODELS = methodSamples["models.list"].result;
const userMsg = (id: string, threadId = "t1", content = "hello"): Message => ({ id, threadId, role: "user", content, createdAt: 1 });
const asstMsg = (id: string, threadId = "t1", content = "hi there"): Message => ({ id, threadId, role: "assistant", content, model: "gemma3:4b", createdAt: 2 });

/** Every state the store published, in order. */
let published: ReturnType<Store["getState"]>[];
/** The stop handle of this test's connect(); the loop must end before the globals go. */
let disconnect: (() => void) | undefined;

beforeEach(async () => {
  b = installBrowser();
  vi.resetModules();
  session = await import("../src/session.ts");
  store = await import("../src/store.ts");
  published = [];
  disconnect = undefined;
  store.subscribe(() => published.push(store.getState()));
});

afterEach(async () => {
  disconnect?.();
  b.server.accepting = false;
  for (const s of b.server.sockets) s.close();
  await tick();
  vi.unstubAllGlobals();
});

const hydrated = () => store.getState().imageStatus !== undefined && store.getState().conn.kind === "open";

function connect(): void {
  disconnect = session.connect();
}

async function boot(): Promise<void> {
  connect();
  await until(hydrated, 2000, "hydration");
  await tick();
}

const chat = (turnId: string, event: Payload<"chat.event">["event"], threadId = "t1") =>
  b.server.push("chat.event", { turnId, threadId, event });

/** Send "hi" from a new thread and wait until chat.send answered turn-1. */
async function startFirstTurn(): Promise<void> {
  void session.send("hi");
  await until(() => store.getState().live?.turnId === "turn-1", 2000, "turn-1");
}

/** Drop the socket and wait until the client has hydrated again on a new one. */
async function reconnect(): Promise<void> {
  const before = b.server.sockets.length;
  store.setState({ imageStatus: undefined });
  b.server.socket.close();
  await until(() => b.server.sockets.length > before, 3000, "a new socket");
  await until(hydrated, 3000, "hydration after reconnect");
  await tick();
}

describe("Stop then Retry (W-02)", () => {
  it("Retry waits for the stopped turn's end, then the new reply ends as a normal reply", async () => {
    await boot();
    await startFirstTurn();
    chat("turn-1", { type: "delta", text: "Partial" });
    await tick();
    b.frame();
    session.stop();
    session.retry(); // at once: the old turn has not ended on the server yet
    await tick();
    expect(b.server.calls("chat.cancel")).toHaveLength(1);
    expect(b.server.calls("chat.send")).toHaveLength(1);

    chat("turn-1", { type: "error", code: "cancelled", message: "cancelled" });
    await tick();
    const held = b.server.hold("chat.send");
    session.retry();
    (await held).respond({ turnId: "turn-2", userMessage: userMsg("m3") });
    await tick();
    chat("turn-2", { type: "delta", text: "Again" });
    await tick();
    b.frame();
    expect(store.getState().live).toMatchObject({ turnId: "turn-2", text: "Again" });
    expect(store.getState().live?.end).toBeUndefined();
    chat("turn-2", { type: "done", message: asstMsg("m4", "t1", "Again"), stopReason: "stop" });
    await tick();
    expect(store.getState().live).toBeNull();
    expect(store.getState().messages["t1"]?.at(-1)?.id).toBe("m4");
  });

  it("a stopped turn's late cancellation never lands on the next message's turn", async () => {
    await boot();
    await startFirstTurn();
    session.stop();
    const held = b.server.hold("chat.send");
    void session.send("next question");
    const h = await held;
    // the old turn's terminal event arrives before the new send has its id
    chat("turn-1", { type: "error", code: "cancelled", message: "cancelled" });
    await tick();
    h.respond({ turnId: "turn-2", userMessage: userMsg("m3", "t1", "next question") });
    await tick();
    chat("turn-2", { type: "delta", text: "Fresh" });
    await tick();
    b.frame();
    expect(store.getState().live).toMatchObject({ turnId: "turn-2", text: "Fresh" });
    expect(store.getState().live?.end).toBeUndefined();
  });

  it("Stop before chat.send answers: the late answer is cancelled and Retry waits for it", async () => {
    await boot();
    const first = b.server.hold("chat.send");
    void session.send("hi");
    const h1 = await first;
    session.stop();
    session.retry();
    await tick();
    expect(b.server.calls("chat.send")).toHaveLength(1);
    h1.respond({ turnId: "turn-1", userMessage: userMsg("m1") });
    await tick();
    expect(b.server.calls("chat.cancel").map((c) => c.params)).toEqual([{ turnId: "turn-1" }]);
    session.retry(); // still waiting for turn-1's terminal event
    await tick();
    expect(b.server.calls("chat.send")).toHaveLength(1);
    chat("turn-1", { type: "error", code: "cancelled", message: "cancelled" });
    await tick();
    session.retry();
    await tick();
    expect(b.server.calls("chat.send")).toHaveLength(2);
  });
});

/** Published states that showed a ready runtime with models but no model chosen (E-01). */
const readyWithoutModel = () => published.filter((s) => s.runtime?.state === "ready" && (s.models?.length ?? 0) > 0 && s.model === undefined);

describe("hydration order (W-03, E-01)", () => {
  it("a ready push while models.list is pending wins over the older starting snapshot", async () => {
    b.server.answer("runtime.status", () => STARTING);
    const models = b.server.hold("models.list");
    connect();
    const h = await models;
    await tick();
    b.server.push("runtime.changed", READY);
    await tick();
    h.respond(MODELS);
    await until(hydrated, 2000, "hydration");
    await tick();
    expect(store.getState().runtime?.state).toBe("ready");
    expect(store.getState().model).toBe("gemma3:4b");
    expect(readyWithoutModel()).toEqual([]);
  });

  it("on reconnect, a ready push between the two batch responses is not undone", async () => {
    await boot();
    b.server.answer("runtime.status", () => STARTING);
    const models = b.server.hold("models.list");
    const before = b.server.sockets.length;
    store.setState({ imageStatus: undefined });
    b.server.socket.close();
    await until(() => b.server.sockets.length > before, 3000, "a new socket");
    const h = await models; // runtime.status has answered "starting" by now
    await tick();
    b.server.push("runtime.changed", READY);
    await tick();
    h.respond(MODELS);
    await until(hydrated, 3000, "hydration after reconnect");
    await tick();
    expect(store.getState().runtime?.state).toBe("ready");
    expect(readyWithoutModel()).toEqual([]);
  });

  it("a gpu push during the second batch is newer than the gpu snapshot", async () => {
    const gpu = b.server.hold("gpu.status");
    connect();
    const h = await gpu;
    const pushed = { ...methodSamples["gpu.status"].result, freeBytes: 1, measuredAt: 99 };
    b.server.push("gpu.changed", pushed);
    await tick();
    h.respond(methodSamples["gpu.status"].result);
    await until(hydrated, 2000, "hydration");
    await tick();
    expect(store.getState().gpu).toEqual(pushed);
  });
});

describe("reconnect reconciles cached threads (W-04)", () => {
  it("drops the retained partial reply once the server has its saved message", async () => {
    await boot();
    await startFirstTurn();
    chat("turn-1", { type: "delta", text: "Half a rep" });
    await tick();
    b.frame();
    // the reply finishes on the server while the socket is down
    b.server.answer("threads.get", () => ({ thread: methodSamples["threads.create"].result, messages: [userMsg("m1", "t1", "hi"), asstMsg("m2", "t1", "Half a reply, finished")] }));
    await reconnect();
    expect(store.getState().live).toBeNull();
    expect(store.getState().messages["t1"]?.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("keeps the failed partial when the server saved nothing for it", async () => {
    await boot();
    await startFirstTurn();
    b.server.answer("threads.get", () => ({ thread: methodSamples["threads.create"].result, messages: [userMsg("m1", "t1", "hi")] }));
    await reconnect();
    expect(store.getState().live?.end).toMatchObject({ kind: "error", code: "closed" });
  });

  it("reloads a background thread visited before the drop on its next visit", async () => {
    const saved: Record<string, Message[]> = { a: [userMsg("a1", "a")], b: [userMsg("b1", "b")] };
    b.server.answer("threads.get", ({ threadId }) => ({ thread: { ...methodSamples["threads.create"].result, id: threadId }, messages: saved[threadId] ?? [] }));
    await boot();
    session.openThread("a");
    await until(() => store.getState().messages["a"] !== undefined);
    session.openThread("b");
    await until(() => store.getState().messages["b"] !== undefined);
    saved["a"] = [userMsg("a1", "a"), asstMsg("a2", "a")];
    await reconnect();
    session.openThread("a");
    await until(() => store.getState().messages["a"]?.length === 2, 1000, "thread a reloaded");
  });
});

describe("Stop keeps buffered words (W-05)", () => {
  it("keeps the words still waiting for a frame", async () => {
    await boot();
    await startFirstTurn();
    chat("turn-1", { type: "delta", text: "Hello" });
    await tick();
    b.frame();
    chat("turn-1", { type: "delta", text: " final pending words" });
    await tick();
    session.stop();
    expect(store.getState().live?.text).toBe("Hello final pending words");
    expect(store.getState().live?.end?.kind).toBe("stopped");
  });
});

describe("runtime Retry (W-06)", () => {
  it("asks the server to look for Ollama again, not for its cached status", async () => {
    await boot();
    b.server.answer("runtime.status", () => ({ state: "wrong-service", owner: "none", baseUrl: "http://127.0.0.1:11434", detail: "nginx" }));
    await session.recheckRuntime();
    expect(b.server.calls("runtime.retry")).toHaveLength(1);
    expect(store.getState().runtime?.state).toBe("ready");
  });
});

/** A server answer that fails with this code and message. */
const refuse = (code: string, message: string) => () => {
  throw Object.assign(new Error(message), { code });
};

describe("action failures come back to the caller (W-07)", () => {
  it("a refused Library add says what failed and what to do", async () => {
    await boot();
    b.server.answer("sources.add", refuse("internal", "ENOENT: no such file or directory, realpath '/nope'"));
    const r = await session.addSource("folder", "/nope");
    expect(r).toBe("Couldn't add this folder because nothing is at that path; check it and try again.");
  });

  it("a settings save that fails says so and changes nothing", async () => {
    await boot();
    b.server.answer("settings.update", refuse("internal", "disk full"));
    const r = await session.updateSettings({ theme: "light" });
    expect(r).toBe("Couldn't save the theme because Gates Local refused it (disk full); try again.");
    expect(store.getState().settings).toEqual(methodSamples["settings.get"].result);
  });

  it("a model action while disconnected says to try again once it reconnects", async () => {
    await boot();
    b.server.accepting = false;
    b.server.socket.close();
    await until(() => store.getState().conn.kind === "down");
    const r = await session.removeModel("gemma3:4b");
    expect(r).toBe("Couldn't remove gemma3:4b because Gates Local isn't connected; try again once it reconnects.");
  });

  it("turning image generation on reads ComfyUI's status again, so Settings shows what it found (W-12)", async () => {
    await boot();
    b.server.answer("image.status", () => ({ state: "missing", owner: "none", baseUrl: "http://127.0.0.1:9", detail: "ComfyUI did not answer." }));
    const before = b.server.calls("image.status").length;
    expect(await session.updateSettings({ imageGen: true })).toBeNull();
    await until(() => {
      const s = store.getState().imageStatus;
      return s !== undefined && s !== store.NA && s.state === "missing";
    }, 1000, "the new image status");
    expect(b.server.calls("image.status").length).toBe(before + 1);
    // a save that touches neither imageGen nor comfyUrl does not ask again
    expect(await session.updateSettings({ theme: "light" })).toBeNull();
    await tick();
    expect(b.server.calls("image.status").length).toBe(before + 1);
  });

  it("success returns null", async () => {
    await boot();
    expect(await session.updateSettings({ theme: "light" })).toBeNull();
    expect(await session.addSource("sqlite", "/home/me/library.db")).toBeNull();
  });
});
