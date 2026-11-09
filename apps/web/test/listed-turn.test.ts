// A reply this client knows only from turns.active, with no event of its own
// yet: it shows as running in the sidebar and nothing more. The server lists a
// turn once its fit passes, before the question is saved; if saving fails, the
// turn is dropped with no chat event at all, so nothing here may wait for it.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Message, Payload } from "@gates-local/contracts";
import { createApp } from "../../server/src/app.ts";
import { openThreadStore } from "../../server/src/threads/store.ts";
import { installBrowser, tick, until } from "./harness.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const clean of cleanups.splice(0)) clean();
});

function cacheTmp(): string {
  const base = path.join(os.homedir(), ".cache", "gates-local-tests");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, "listed-turn-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const noop = () => {};
const never = () => { throw new Error("activeTurns only returns a patch"); };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = noop;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

it("a turn the server listed but never started holds no queue, and the next hydration drops it", async () => {
  const b = installBrowser();
  const db = openThreadStore(path.join(cacheTmp(), "threads.sqlite"));
  const a = db.createThread({ title: "A" });
  const signal = new AbortController().signal;
  const show: unknown = JSON.parse(readFileSync(new URL("../../server/src/fit/fixtures/show-qwen3-5-9b.json", import.meta.url), "utf8"));
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    const where = new URL(String(url)).pathname;
    if (where === "/api/show") return Response.json(show);
    if (where === "/api/ps") return Response.json({ models: [] });
    if (where === "/api/tags") return Response.json({ models: [{ name: "qwen3.5:9b", size: 6600000000, digest: "d", modified_at: "2026-11-01T00:00:00Z" }] });
    throw new Error(`Unexpected request: ${where}`);
  });
  const admitted = deferred();
  const gate = deferred();
  const pushes: unknown[] = [];
  const app = createApp({
    store: db,
    runtime: { status: () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }), baseUrl: () => "http://fake", onChange: () => () => {}, ensure: async () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }), lookIfDown: async () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }) },
    catalog: { current: () => [], refresh: async () => ({ models: [], changed: false }), onChange: () => () => {}, stop: () => {} },
    push: (channel, payload) => { pushes.push({ channel, payload }); },
    fit: { runNvidiaSmi: async args => args[0]?.startsWith("--query-gpu") ? "16384, 1024, 15360\n" : "", readMeminfo: async () => "MemAvailable: 32000000 kB\n" },
    models: { handlers: {}, loader: { reserve: () => ({
      baseUrl: "http://fake", signal, firstToken: () => {}, end: () => {},
      admit: async (_ctx, options) => {
        if (options?.fit === undefined) throw new Error("missing app fit");
        const report = await options.fit(signal);
        admitted.resolve(); await gate.promise; return report;
      },
    }) } },
  });
  let disconnect: (() => void) | undefined;
  const rejected = new Error("disk full while saving the question");
  vi.spyOn(db, "appendMessage").mockImplementationOnce(() => { throw rejected; });
  const sending = Promise.resolve(app.handlers["chat.send"]({ threadId: a.id, content: "A", model: "qwen3.5:9b", numCtx: 16384 }, { clientId: 1 })).catch((error: unknown) => error);
  try {
    // another client sent in A; its fit passed, so the server lists the turn
    await admitted.promise;
    const listActive = app.handlers["turns.active"];
    if (listActive === undefined) throw new Error("the server has no turns.active");
    const snapshot = await listActive({}, { clientId: 2 });
    expect(snapshot).toHaveLength(1);
    const replay: unknown[] = [];
    app.replayTurns((channel, payload) => { replay.push({ channel, payload }); });
    expect(replay).toEqual([]);
    let listed = snapshot;
    b.server.answer("turns.active", () => listed);
    b.server.answer("threads.list", () => [a]);
    b.server.answer("threads.create", () => ({ id: "B", title: "B", createdAt: 1, updatedAt: 1 }));
    b.server.answer("threads.get", ({ threadId }) => ({ thread: { id: threadId, title: threadId, createdAt: 1, updatedAt: 1 }, messages: [] }));
    b.server.answer("chat.send", ({ threadId, content }) => ({ turnId: `turn-${threadId}`, userMessage: { id: `u-${threadId}`, threadId, role: "user", content, createdAt: 1 } }));
    vi.resetModules();
    const session = await import("../src/session.ts");
    const store = await import("../src/store.ts");
    disconnect = session.connect();
    await until(() => store.getState().imageStatus !== undefined);
    expect(store.runningThreads(store.getState()).has(a.id), "the sidebar shows A running").toBe(true);
    expect.soft(store.runningTurn(store.getState(), a.id), "A has no reply to stop yet").toBeUndefined();
    // saving the question fails: the server drops the turn and says nothing
    gate.resolve();
    expect(await sending).toBe(rejected);
    expect(app.activeTurns()).toBe(0);
    expect(pushes).toEqual([]);
    session.newThread();
    await session.send("B");
    await session.send("after B");
    b.server.push("chat.event", { threadId: "B", turnId: "turn-B", event: { type: "done", message: { id: "aB", threadId: "B", role: "assistant", content: "B finished", createdAt: 2 }, stopReason: "stop" } });
    await tick(); b.frame();
    expect.soft(b.server.calls("chat.send").map(call => call.params), "the queue goes on once B finishes").toHaveLength(2);
    expect.soft(store.getState().queued).toEqual([]);
    // the person opens A; the next hydration no longer lists its turn, and the mark goes
    session.openThread(a.id);
    await tick();
    listed = [];
    const before = b.server.sockets.length;
    b.server.socket.close();
    await until(() => b.server.sockets.length > before);
    await until(() => store.getState().turns[a.id] === undefined, 2000, "the unlisted turn to go");
    expect(store.runningThreads(store.getState()).has(a.id)).toBe(false);
  } finally {
    gate.resolve(); await sending; disconnect?.(); b.server.accepting = false;
    for (const socket of b.server.sockets) socket.close();
    await tick(); await app.shutdown(); db.close();
  }
});

it("a listed turn's clock starts at its own start, not at the hydration that listed it", async () => {
  const b = installBrowser();
  let skew = 0;
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
  const question: Message = { id: "their-question", threadId: "A", role: "user", content: "theirs", createdAt: 1 };
  const answer: Message = { id: "their-answer", threadId: "A", role: "assistant", content: "First words", createdAt: 2 };
  const chat = (event: Payload<"chat.event">["event"]) => b.server.push("chat.event", { threadId: "A", turnId: "other", event });
  b.server.answer("turns.active", () => [{ threadId: "A", turnId: "other" }]);
  b.server.answer("threads.get", ({ threadId }) => ({ thread: { id: threadId, title: threadId, createdAt: 1, updatedAt: 1 }, messages: [] }));
  vi.resetModules();
  const session = await import("../src/session.ts");
  const store = await import("../src/store.ts");
  const disconnect = session.connect();
  try {
    await until(() => store.getState().imageStatus !== undefined);
    session.openThread("A");
    await tick();
    expect(store.getState().turns.A?.listed).toBe(true);
    // another client's question waits 20 s before the model starts on it
    skew += 20_000;
    chat({ type: "start", model: "qwen3.5:9b", userMessage: question });
    chat({ type: "thinking", text: "Let me think" });
    await tick(); b.frame();
    skew += 5_000;
    chat({ type: "delta", text: "First words" });
    await tick(); b.frame();
    expect(store.getState().turns.A?.thinkingSecs, "it thought from its start to its first word").toBe(5);
    chat({ type: "done", message: answer, stopReason: "stop" });
    await tick();
    expect(store.getState().firstToken[answer.id], "the first word came 5 s after the start").toBeGreaterThanOrEqual(5_000);
    expect(store.getState().firstToken[answer.id]).toBeLessThan(6_000);
  } finally {
    disconnect(); b.server.accepting = false;
    for (const socket of b.server.sockets) socket.close();
    await tick();
  }
});

// In the app every hydration follows a dropped connection, and lostTurn has
// already dropped listed turns by then; this holds the rule on its own.
it("a hydration whose turns.active no longer lists a listed turn drops it, with no dropped connection first", async () => {
  installBrowser();
  vi.resetModules();
  const store = await import("../src/store.ts");
  const { createChat } = await import("../src/session/chat.ts");
  const chat = createChat({
    applyServerEvent: never, call: never, codeOf: () => "", createThread: never, creatingDraft: () => false, loadThread: never, loading: () => false,
    noteMessage: never, withMessage: never, untrackedDone: never, openThread: never, blockingFor: never, invalidateFits: never,
  });
  const listing = [{ threadId: "A", turnId: "other" }];
  store.setState(chat.activeTurns(store.getState(), listing));
  expect(store.getState().turns.A?.listed).toBe(true);
  store.setState(chat.activeTurns(store.getState(), listing));
  expect(store.getState().turns.A?.listed, "still listed: it stays").toBe(true);
  expect(chat.activeTurns(store.getState(), []).turns, "no longer listed: it goes").toEqual({});
});
