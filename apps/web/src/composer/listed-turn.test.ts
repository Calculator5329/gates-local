// A reply this window knows only from the server's list of records, with no
// word of its own yet: it is its chat's turn, on its way. The server lists a
// reply from the moment a send is taken, before the question is saved; if
// saving fails, its record leaves and the turn goes here too (chat row 32),
// and a list that no longer names it drops it as well.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Message, Payload, ReplyListed } from "@gates-local/contracts";
import { createApp } from "@gates-local/server/app.ts";
import { sendStarted } from "@gates-local/server/chat/send-started.ts";
import { openThreadStore } from "@gates-local/server/threads/store.ts";
import { installBrowser, tick, until } from "../../test/harness.ts";
import { queuedOf } from "../../test/queue.ts";
import type { TurnSaid } from "@gates-local/server/app/turn.ts";
import type { ReplyRecord } from "@gates-local/server/chat/times.ts";

const cleanups: (() => void)[] = [];
/** The server's reply record of a turn still waiting (decision 33). */
const record: ReplyRecord = { stage: "waiting", startedAt: 0, workMs: 0, toolMs: 0, attempt: 1, spans: [], callsAt: {} };
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
const qwen = { name: "qwen3.5:9b", digest: "d", sizeBytes: 6_600_000_000, modifiedAt: "2026-11-01T00:00:00Z", capabilities: ["completion" as const] };
const never = () => { throw new Error("a list of records asks the server nothing"); };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = noop;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

it("a listed turn that fails before its start puts the sidebar's dot out, waits on hold, and stays gone after hydration", async () => {
  const b = installBrowser();
  const db = openThreadStore(path.join(cacheTmp(), "threads.sqlite"));
  const a = db.createThread({ title: "A" });
  const signal = new AbortController().signal;
  const show: unknown = JSON.parse(readFileSync(createRequire(import.meta.url).resolve("@gates-local/server/fit/fixtures/show-qwen3-5-9b.json"), "utf8"));
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
    catalog: { current: () => [qwen], refresh: async () => ({ models: [qwen], changed: false }), onChange: () => () => {}, stop: () => {} },
    push: (channel, payload) => { pushes.push({ channel, payload }); },
    turnSaid: (said) => { pushes.push({ channel: "turn", payload: said }); },
    fit: { runNvidiaSmi: async args => args[0]?.startsWith("--query-gpu") ? "16384, 1024, 15360\n" : "", readMeminfo: async () => "MemAvailable: 32000000 kB\n" },
    models: { handlers: {}, loader: { reserve: () => ({
      baseUrl: "http://fake", signal, cold: false, firstToken: () => {}, end: () => {},
      admit: async (_ctx, options) => {
        if (options?.fit === undefined) throw new Error("missing app fit");
        const report = await options.fit(signal, { handoff: undefined, leave: async () => undefined });
        admitted.resolve(); await gate.promise; return report;
      },
    }) } },
  });
  let disconnect: (() => void) | undefined;
  const rejected = new Error("disk full while saving the question");
  vi.spyOn(db, "appendMessage").mockImplementationOnce(() => { throw rejected; });
  const sending = sendStarted(app, { threadId: a.id, content: "A", model: "qwen3.5:9b", numCtx: 16384 }).catch((error: unknown) => error);
  try {
    // another client sent in A; its fit passed, so the server lists the turn
    await admitted.promise;
    // what a window is given at connect: the server's records, with this reply on its way
    const list = app.handlers["reply.list"];
    if (list === undefined) throw new Error("the server has no reply.list");
    let listed = await list({}, { clientId: 2 });
    expect(listed).toMatchObject([{ reply: { threadId: a.id, stage: "starting" } }]);
    expect(listed[0], "no question saved, so no words to list").not.toHaveProperty("soFar");
    const theirs = listed[0]!.reply.id;
    b.server.answer("reply.list", () => listed);
    b.server.answer("threads.list", () => [a]);
    b.server.answer("threads.create", () => ({ id: "B", title: "B", createdAt: 1, updatedAt: 1 }));
    b.server.answer("threads.get", ({ threadId }) => ({ thread: { id: threadId, title: threadId, createdAt: 1, updatedAt: 1 }, messages: [] }));
    b.server.answer("turn.start", ({ threadId, content }) => ({ turnId: `turn-${threadId}`, userMessage: { id: `u-${threadId}`, threadId, role: "user", content, createdAt: 1 } }));
    vi.resetModules();
    const session = await import("../lib/session/index.ts");
    const store = await import("../lib/store/store.ts");
    disconnect = session.connect();
    await until(() => store.getState().imageStatus !== undefined);
    expect(store.runningThreads(store.getState()).has(a.id), "the sidebar shows A running").toBe(true);
    expect.soft(store.runningTurn(store.getState(), a.id), "A's reply on its way, with no question saved yet").toMatchObject({ turnId: theirs });
    expect.soft(store.unsavedQuestion(store.getState(), store.runningTurn(store.getState(), a.id))?.text).toBe("A");
    // saving the question fails: the server ends the turn and says so to every client (chat row 32)
    const told = pushes.length;
    gate.resolve();
    expect(await sending).toBe(rejected);
    expect(app.activeTurns()).toBe(0);
    const since = pushes.slice(told);
    const said = since.filter((p): p is { channel: "turn"; payload: TurnSaid } => (p as { channel: string }).channel === "turn");
    expect(said.map((p) => p.payload.event)).toEqual([expect.objectContaining({ type: "error", code: "internal", ended: { reason: "failed", at: expect.any(Number) } })]);
    // its message waits on hold in every window with the reason, its question never saved
    const ended = since.filter((p): p is { channel: "reply.changed"; payload: Payload<"reply.changed"> } => (p as { channel: string }).channel === "reply.changed");
    expect(ended.map((p) => p.payload)).toEqual([expect.objectContaining({ kind: "is", reply: expect.objectContaining({ id: theirs, stage: "held", held: expect.objectContaining({ why: "refused", code: "internal" }) }) })]);
    expect(ended[0]!.payload).not.toHaveProperty("reply.questionId");
    b.server.push("turn", said[0]!.payload);
    b.server.push("reply.changed", ended[0]!.payload);
    await tick();
    expect(store.runningThreads(store.getState()).has(a.id), "the sidebar's working dot goes out").toBe(false);
    expect(store.getState().turns[a.id]).toBeUndefined();
    session.newThread();
    await session.send("B");
    await session.send("after B");
    b.server.push("turn", { threadId: "B", turnId: "turn-B", event: { type: "done", message: { id: "aB", threadId: "B", role: "assistant", content: "B finished", createdAt: 2 }, stopReason: "stop" } });
    await tick(); b.frame();
    expect.soft(b.server.calls("turn.start").map(call => call.params), "the queue goes on once B finishes").toHaveLength(2);
    expect.soft(queuedOf(store.getState()), "only A's message waits, on hold").toEqual([expect.objectContaining({ threadId: a.id, held: true, why: expect.objectContaining({ code: "internal" }) })]);
    // the person opens A; the next list no longer names its reply, and the mark stays gone
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

it("a listed reply draws the server's record: the one reply.list gave, then each one pushed (decision 33)", async () => {
  const b = installBrowser();
  let skew = 0;
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
  const question: Message = { id: "their-question", threadId: "A", role: "user", content: "theirs", createdAt: 1 };
  const answer: Message = { id: "their-answer", threadId: "A", role: "assistant", content: "First words", createdAt: 2 };
  const chat = (event: TurnSaid["event"]) => b.server.push("turn", { threadId: "A", turnId: "other", event });
  // another window's send, taken before this one connected: its model is loading, its question not saved yet
  b.server.answer("reply.list", () => [{ reply: { id: "other", threadId: "A", rev: 1, messageId: question.id, text: question.content, at: 1, stage: "starting", attempt: 1, startedAt: 0, loading: true } }]);
  b.server.answer("threads.get", ({ threadId }) => ({ thread: { id: threadId, title: threadId, createdAt: 1, updatedAt: 1 }, messages: [] }));
  vi.resetModules();
  const session = await import("../lib/session/index.ts");
  const store = await import("../lib/store/store.ts");
  const disconnect = session.connect();
  try {
    await until(() => store.getState().imageStatus !== undefined);
    session.openThread("A");
    await tick();
    expect(store.getState().turns.A).toMatchObject({ turnId: "other", reply: { stage: "loading" } });
    expect(store.unsavedQuestion(store.getState(), store.getState().turns.A ?? undefined)?.text).toBe("theirs");
    // another client's question waits 20 s before the model starts on it
    skew += 20_000;
    chat({ type: "start", model: "qwen3.5:9b", userMessage: question });
    chat({ type: "reply", reply: { ...record, stage: "thinking", readyAt: 20_000 } });
    chat({ type: "thinking", text: "Let me think" });
    await tick(); b.frame();
    skew += 5_000;
    chat({ type: "reply", reply: { ...record, stage: "writing", readyAt: 20_000, firstTokenAt: 25_000, workMs: 5000 } });
    chat({ type: "delta", text: "First words" });
    await tick(); b.frame();
    expect(store.getState().turns.A?.reply, "the server's work seconds, not a guess here").toMatchObject({ stage: "writing", workMs: 5000 });
    chat({ type: "done", message: answer, stopReason: "stop" });
    await tick();
    // the saved reply's first-token time is the server's, stamped on its row (chat row 32)
    expect(store.getState().turns.A).toBeUndefined();
  } finally {
    disconnect(); b.server.accepting = false;
    for (const socket of b.server.sockets) socket.close();
    await tick();
  }
});

// In the app every list follows a dropped connection; this holds the rule on its own.
it("a list that no longer names a reply on its way drops it and its turn, with no dropped connection first", async () => {
  installBrowser();
  vi.resetModules();
  const store = await import("../lib/store/store.ts");
  const { createChat } = await import("./chat.ts");
  const chat = createChat({
    applyServerEvent: (patch: Parameters<typeof store.setState>[0]) => store.setState(patch),
    call: never, reply: never, codeOf: () => "", createThread: never, creatingDraft: () => false, loadThread: never, loading: () => false,
    noteMessage: never, withMessage: never, untrackedDone: never, openThread: never, blockingFor: never,
  } as unknown as Parameters<typeof createChat>[0]);
  const listing: readonly ReplyListed[] = [{ reply: { id: "other", threadId: "A", rev: 1, messageId: "their-question", text: "theirs", at: 1, stage: "starting", attempt: 1, startedAt: 0 } }];
  chat.connected(); chat.replyListed(listing);
  expect(store.getState().turns.A?.turnId).toBe("other");
  chat.connected(); chat.replyListed(listing);
  expect(store.getState().turns.A?.turnId, "still listed: it stays").toBe("other");
  chat.connected(); chat.replyListed([]);
  expect(store.getState().turns, "no longer listed: it goes").toEqual({});
  expect(store.getState().replies.size).toBe(0);
});

it("a list of replies that fails to read leaves the words to come in as they arrive, not held for a list that will not come", async () => {
  const b = installBrowser();
  b.server.answer("reply.list", () => { throw { code: "internal", message: "the list failed" }; });
  b.server.answer("threads.get", ({ threadId }) => ({ thread: { id: threadId, title: threadId, createdAt: 1, updatedAt: 1 }, messages: [] }));
  vi.resetModules();
  const session = await import("../lib/session/index.ts");
  const store = await import("../lib/store/store.ts");
  const disconnect = session.connect();
  try {
    await until(() => store.getState().imageStatus !== undefined);
    session.openThread("A");
    await tick();
    b.server.push("reply.changed", { kind: "is", reply: { id: "other", threadId: "A", rev: 2, questionId: "q", model: "qwen3.5:9b", startedAt: 1, workMs: 0, toolMs: 0, try: 1, spans: [], callsAt: {}, stage: "writing" } });
    b.server.push("reply.words", { id: "other", part: { type: "text", from: 0, text: "First words" } });
    await tick(); b.frame();
    expect(store.getState().turns.A?.text).toBe("First words");
  } finally {
    disconnect(); b.server.accepting = false;
    for (const socket of b.server.sockets) socket.close();
    await tick();
  }
});
