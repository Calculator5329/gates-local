// The client session against an in-memory server (test/harness.ts): turn
// generations around Stop and Retry, the hydration order, reconnect
// reconciliation, the buffered words Stop keeps, runtime Retry and the
// failures actions hand back to the UI.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, Payload, RuntimeStatus } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { type Browser, type Held, installBrowser, tick, until } from "./harness.ts";

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
    // the composer starts on the server's pick (ModelInfo.pick), which the samples put on qwen3:14b
    expect(store.getState().model).toBe(MODELS.find((m) => m.pick !== undefined)?.name);
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

describe("the catalog follows the model list", () => {
  it("a models.changed push (a removal, a runtime switch) reloads the catalog, so no stale Installed mark stays", async () => {
    const sample = methodSamples["models.catalog"].result;
    b.server.answer("models.catalog", () => sample.map((c) => ({ ...c, installed: true })));
    await boot();
    expect(store.getState().catalog).toEqual(sample.map((c) => ({ ...c, installed: true })));
    b.server.answer("models.catalog", () => sample.map((c) => ({ ...c, installed: false })));
    b.server.push("models.changed", []);
    await until(() => {
      const c = store.getState().catalog;
      return Array.isArray(c) && c.every((e) => !e.installed);
    }, 2000, "a refreshed catalog");
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

const snapshot = (messages: Message[]) => ({ thread: methodSamples["threads.create"].result, messages });

/** Drop the socket; the reconnect's reload of the open thread waits until the test answers it. */
async function reconnectHeld() {
  const held = b.server.hold("threads.get");
  const before = b.server.sockets.length;
  store.setState({ imageStatus: undefined });
  b.server.socket.close();
  await until(() => b.server.sockets.length > before, 3000, "a new socket");
  const h = await held;
  await until(hydrated, 3000, "hydration after reconnect");
  return h;
}

describe("Retry after a reconnect (WF-01)", () => {
  it("the pre-drop turn's late events never reach the Retry, which keeps its server turn and renders", async () => {
    await boot();
    await startFirstTurn();
    (await reconnectHeld()).respond(snapshot([userMsg("m1", "t1", "hi")]));
    await tick();
    expect(store.getState().live?.end).toMatchObject({ kind: "error", code: "closed" });

    const send = b.server.hold("chat.send");
    session.retry();
    const pending = await send;
    const gen = store.getState().live?.gen;
    // turn-1 kept running on the server; turn-2's first words beat its chat.send answer
    chat("turn-1", { type: "delta", text: "stale " });
    chat("turn-2", { type: "delta", text: "Fresh " });
    chat("turn-1", { type: "done", message: asstMsg("m2", "t1", "the old reply"), stopReason: "stop" });
    await tick();
    expect(store.getState().live?.gen).toBe(gen);
    pending.respond({ turnId: "turn-2", userMessage: userMsg("m3", "t1", "hi") });
    await tick();
    expect(b.server.calls("chat.cancel").map((c) => c.params)).toEqual([]);
    b.frame();
    expect(store.getState().live).toMatchObject({ turnId: "turn-2", text: "Fresh " });
    chat("turn-2", { type: "delta", text: "and whole" });
    await tick();
    b.frame();
    expect(store.getState().live?.text).toBe("Fresh and whole");
    chat("turn-2", { type: "done", message: asstMsg("m4", "t1", "Fresh and whole"), stopReason: "stop" });
    await tick();
    expect(store.getState().live).toBeNull();
    expect(store.getState().messages["t1"]?.at(-1)).toMatchObject({ id: "m4", content: "Fresh and whole" });
  });
});

describe("events while a send waits for its id (WF-01)", () => {
  it("a turn this client never saw cannot end the send; the refusal comes back and that turn's reply loads", async () => {
    await boot();
    session.openThread("t1");
    await until(() => store.getState().messages["t1"] !== undefined);
    const send = b.server.hold("chat.send");
    void session.send("mine");
    const pending = await send;
    const gen = store.getState().live?.gen;
    // another client's turn in this thread finishes before the server refuses this send
    chat("turn-9", { type: "delta", text: "theirs" });
    chat("turn-9", { type: "done", message: asstMsg("m9", "t1", "theirs"), stopReason: "stop" });
    await tick();
    expect(store.getState().live?.gen).toBe(gen);
    expect(store.getState().live?.text).toBe("");
    const loads = b.server.calls("threads.get").length;
    pending.fail("turn-active", "thread t1 already has turn turn-9 streaming");
    await tick();
    expect(store.getState()).toMatchObject({ live: null, draft: "mine", notice: "A reply is still being written in this thread. Stop it or wait." });
    expect(b.server.calls("threads.get").length).toBe(loads + 1);
  });
});

describe("thread loads against newer pushes and navigation (WF-02, WF-03)", () => {
  it("a reply that finishes while the reconnect's thread load waits survives the older snapshot", async () => {
    await boot();
    await startFirstTurn();
    const held = await reconnectHeld();
    chat("turn-1", { type: "done", message: asstMsg("m2", "t1", "Finished"), stopReason: "stop" });
    await tick();
    expect(store.getState().messages["t1"]?.map((m) => m.id)).toEqual(["m1", "m2"]);
    held.respond(snapshot([userMsg("m1", "t1", "hi")]));
    await tick();
    expect(store.getState().messages["t1"]?.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(store.getState().live).toBeNull();
  });

  it("a thread load that fails after the user moved to another thread leaves them there", async () => {
    await boot();
    const holdA = b.server.hold("threads.get");
    session.openThread("a");
    const a = await holdA;
    session.openThread("b");
    await tick();
    a.fail("thread-not-found");
    await tick();
    expect(store.getState()).toMatchObject({ view: "thread", threadId: "b" });
  });

  it("a reply another client's turn saved while this client's first load waits survives the older snapshot", async () => {
    await boot();
    const first = b.server.hold("threads.get");
    session.openThread("t1");
    const held = await first;
    // a turn this client never tracked (opened mid-turn) finishes; its reload returns the newer thread
    b.server.answer("threads.get", () => snapshot([userMsg("m1", "t1", "hi"), asstMsg("m2", "t1", "Theirs")]));
    chat("turn-5", { type: "done", message: asstMsg("m2", "t1", "Theirs"), stopReason: "stop" });
    await until(() => store.getState().messages["t1"]?.length === 2, 1000, "the reload after their done");
    held.respond(snapshot([userMsg("m1", "t1", "hi")]));
    await tick();
    expect(store.getState().messages["t1"]?.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("a reconnect reload that fails while Settings is open leaves Settings open", async () => {
    await boot();
    session.openThread("t1");
    await until(() => store.getState().messages["t1"] !== undefined);
    session.openSettings();
    const held = await reconnectHeld();
    held.fail("internal", "store busy");
    await tick();
    expect(store.getState()).toMatchObject({ view: "settings", threadId: "t1" });
  });

  it("a reconnect reload that fails after Settings opened leaves Settings open", async () => {
    await boot();
    session.openThread("t1");
    await until(() => store.getState().messages["t1"] !== undefined);
    const held = await reconnectHeld();
    session.openSettings();
    held.fail("internal", "store busy");
    await tick();
    expect(store.getState()).toMatchObject({ view: "settings", threadId: "t1" });
  });

  it("a reload started in Settings that fails after leaving Settings is stale and keeps the thread", async () => {
    await boot();
    session.openThread("t1");
    await until(() => store.getState().messages["t1"] !== undefined);
    session.openSettings();
    const held = await reconnectHeld();
    session.leaveSettings();
    held.fail("internal", "store busy");
    await tick();
    expect(store.getState()).toMatchObject({ view: "thread", threadId: "t1" });
  });

  it("a load that fails for the thread still open goes to a new thread", async () => {
    await boot();
    b.server.answer("threads.get", refuse("thread-not-found", "no thread a"));
    session.openThread("a");
    await until(() => store.getState().view === "new", 1000, "the new-thread screen");
    expect(store.getState().threadId).toBeNull();
  });

  it("a thread with nothing on screen whose load failed says why, and leaving Settings or Retry loads it again", async () => {
    await boot();
    const first = b.server.hold("threads.get");
    session.openThread("t1");
    await first;
    session.openSettings();
    const held = await reconnectHeld();
    session.leaveSettings();
    held.fail("internal", "store busy");
    await tick();
    expect(store.getState()).toMatchObject({ view: "thread", threadId: "t1", loadErrors: { t1: expect.stringMatching(/^Couldn't load this conversation because/) } });
    expect(store.getState().messages["t1"]).toBeUndefined();
    const again = b.server.hold("threads.get");
    session.openSettings();
    session.leaveSettings();
    (await again).fail("internal", "store busy");
    await tick();
    expect(store.getState()).toMatchObject({ view: "thread", threadId: "t1", loadErrors: { t1: expect.stringMatching(/^Couldn't load/) } });
    b.server.answer("threads.get", () => snapshot([userMsg("m1", "t1", "hi")]));
    session.reloadThread("t1");
    await until(() => store.getState().messages["t1"] !== undefined, 1000, "the retried load");
    expect(store.getState().loadErrors["t1"]).toBeUndefined();
  });
});

const plain = () => snapshot([userMsg("m1", "t1", "hi")]);
const withImage = () => snapshot([userMsg("m1", "t1", "hi"), { ...asstMsg("m2", "t1", "a fox"), images: ["images/j1.png"] }]);
/** What the image module sends after it saved a job's message into t1. */
function imageDone(): void {
  b.server.push("threads.changed", { threadId: "t1" });
  b.server.push("image.event", { jobId: "j1", threadId: "t1", state: "done", progress: 1, imagePath: "images/j1.png" });
}

describe("an image saved into a thread outside chat events (WF3-01)", () => {
  it("names the failed job when retrying and returns the accepted job id", async () => {
    await boot();
    const held = b.server.hold("image.generate");
    const result = session.retryImage("t1", "a fox", "j1");
    const request = await held;
    expect(request.params).toMatchObject({ threadId: "t1", prompt: "a fox", retryOf: "j1" });
    request.respond({ jobId: "retry1" });
    expect(await result).toEqual({ jobId: "retry1" });
  });
  it.each(["queued", "running", "error", "cancelled"] as const)("reloads a persisted %s card without waiting for a done event", async (state) => {
    await boot();
    b.server.answer("threads.get", plain);
    session.openThread("t1");
    await until(() => store.getState().messages["t1"] !== undefined);
    const imageJob = { jobId: "j1", threadId: "t1", state };
    b.server.answer("threads.get", () => snapshot([userMsg("m1"), { ...asstMsg("j1"), imageJob }]));
    b.server.push("image.event", imageJob);
    await until(() => store.getState().messages["t1"]?.at(-1)?.imageJob?.state === state, 1000, "the image card reload");
  });
  it("a cached conversation reloads and shows it, also after switching away and back", async () => {
    await boot();
    b.server.answer("threads.get", plain);
    session.openThread("t1");
    await until(() => store.getState().messages["t1"] !== undefined);
    b.server.answer("threads.get", withImage);
    imageDone();
    await until(() => store.getState().messages["t1"]?.length === 2, 1000, "the reload after the image");
    session.openThread("b");
    await tick();
    session.openThread("t1");
    await tick();
    expect(store.getState().messages["t1"]?.at(-1)?.images).toEqual(["images/j1.png"]);
  });

  it("an older load still in flight never overwrites the snapshot with the image", async () => {
    await boot();
    b.server.answer("threads.get", plain);
    session.openThread("t1");
    await until(() => store.getState().messages["t1"] !== undefined);
    const older = await reconnectHeld();
    b.server.answer("threads.get", withImage);
    imageDone();
    await until(() => store.getState().messages["t1"]?.length === 2, 1000, "the reload after the image");
    older.respond(plain());
    await tick();
    expect(store.getState().messages["t1"]?.map((m) => m.id)).toEqual(["m1", "m2"]);
  });
});

/** t1 cached, then two reloads held in order: the newer one fails first. */
async function newerFailed(): Promise<Held<"threads.get">> {
  await boot();
  b.server.answer("threads.get", plain);
  session.openThread("t1");
  await until(() => store.getState().messages["t1"] !== undefined);
  const olderHeld = b.server.hold("threads.get");
  session.reloadThread("t1");
  const older = await olderHeld;
  const newerHeld = b.server.hold("threads.get");
  session.reloadThread("t1");
  (await newerHeld).fail("internal", "newer load failed");
  await tick();
  expect(store.getState().loadErrors["t1"]).toContain("newer load failed");
  return older;
}

describe("an older load that answers after a newer load failed (WF4-01)", () => {
  it("an older snapshot does not clear the newer failure and its Retry", async () => {
    const older = await newerFailed();
    older.respond(plain());
    await tick();
    expect(store.getState().loadErrors["t1"]).toContain("newer load failed");
  });

  it("an older failure does not replace the newer failure's reason", async () => {
    const older = await newerFailed();
    older.fail("internal", "older load failed");
    await tick();
    expect(store.getState().loadErrors["t1"]).toContain("newer load failed");
  });
});

const others: Array<() => void> = [];
afterEach(() => {
  for (const stop of others.splice(0)) stop();
});

/** A second client (its own session and store modules) on the same fake server, hydrated. */
async function secondClient(): Promise<{ session: Session; store: Store }> {
  vi.resetModules();
  const s2 = await import("../src/session.ts");
  const st2 = await import("../src/store.ts");
  others.push(s2.connect());
  await until(() => st2.getState().imageStatus !== undefined && st2.getState().conn.kind === "open", 2000, "the second client");
  await tick();
  return { session: s2, store: st2 };
}

describe("the same thread open in two clients (PH-02)", () => {
  it("a reply started in one streams in both before it finishes", async () => {
    await boot();
    session.openThread("t1");
    const other = await secondClient();
    other.session.openThread("t1");
    await until(() => other.store.getState().messages["t1"] !== undefined, 1000, "t1 in the second client");
    const saved = other.store.getState().messages["t1"]?.length ?? 0;

    const send = b.server.hold("chat.send");
    void session.send("hello");
    const pending = await send;
    const userMessage = { ...userMsg("m5", "t1", "hello"), createdAt: 5 };
    // the real server pushes start before chat.send answers (apps/server/src/app.ts runTurn), naming the model sent: the server's pick
    b.server.broadcast("chat.event", { turnId: "turn-7", threadId: "t1", event: { type: "start", model: "qwen3:14b", userMessage } });
    pending.respond({ turnId: "turn-7", userMessage });
    await tick();
    b.server.broadcast("chat.event", { turnId: "turn-7", threadId: "t1", event: { type: "delta", text: "Half a" } });
    await tick();
    b.frame();
    for (const st of [store, other.store]) {
      expect(st.getState().live, st === store ? "the sender" : "the other client").toMatchObject({ turnId: "turn-7", text: "Half a", model: "qwen3:14b" });
      expect(st.getState().live?.end).toBeUndefined();
      expect(st.getState().messages["t1"]?.filter((m) => m.id === "m5")).toHaveLength(1);
    }
    b.server.broadcast("chat.event", { turnId: "turn-7", threadId: "t1", event: { type: "done", message: asstMsg("m6", "t1", "Half a reply"), stopReason: "stop" } });
    await tick();
    for (const st of [store, other.store]) {
      expect(st.getState().live).toBeNull();
      expect(st.getState().messages["t1"]?.at(-1)?.id).toBe("m6");
    }
    expect(other.store.getState().messages["t1"]).toHaveLength(saved + 2);
  });

  it("a send stopped before its answer, then refused, holds no later turn's events", async () => {
    await boot();
    session.openThread("t1");
    await until(() => store.getState().messages["t1"] !== undefined);
    const send = b.server.hold("chat.send");
    void session.send("mine");
    const pending = await send;
    session.stop();
    pending.fail("cancelled", "the turn was cancelled before it started");
    await tick();
    expect(store.getState().live).toMatchObject({ turnId: null, end: { kind: "stopped" } });
    // later, the other client's turn in this thread streams here
    chat("turn-8", { type: "start", model: "gemma3:4b", userMessage: userMsg("m8", "t1", "theirs") });
    chat("turn-8", { type: "delta", text: "Theirs" });
    await tick();
    b.frame();
    expect(store.getState().live).toMatchObject({ turnId: "turn-8", text: "Theirs" });
  });

  it("a turn in a thread the client does not have open starts nothing there", async () => {
    await boot();
    session.openThread("t1");
    await until(() => store.getState().messages["t1"] !== undefined);
    b.server.push("chat.event", { turnId: "turn-8", threadId: "t2", event: { type: "start", model: "gemma3:4b", userMessage: userMsg("x1", "t2") } });
    b.server.push("chat.event", { turnId: "turn-8", threadId: "t2", event: { type: "delta", text: "elsewhere" } });
    await tick();
    b.frame();
    expect(store.getState().live).toBeNull();
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
