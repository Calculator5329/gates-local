// What a Stop leaves behind when the server's end comes after it: the server
// says how the turn ended (chat row 32), a real failure that lands after a
// Stop is said, on screen or off it, and the rows it saved say it once the
// turn leaves the screen, in place of the copies here.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Message, Payload, ReplyTimes } from "@gates-local/contracts";
import { drawTimes } from "../src/session/times.ts";
import { type Browser, installBrowser, tick, until } from "./harness.ts";

let b: Browser;
let session: typeof import("../src/session.ts");
let store: typeof import("../src/store.ts");
let disconnect: (() => void) | undefined;
let created: string[] = [];

const st = () => store.getState();
const userMsg = (id: string, threadId: string, content: string): Message => ({ id, threadId, role: "user", content, createdAt: 1 });
const chat = (turnId: string, threadId: string, event: Payload<"chat.event">["event"]) => b.server.push("chat.event", { turnId, threadId, event });
/** The times the server stamps on a row as its turn ends. */
const stamped = (reason: ReplyTimes["ended"]["reason"], why?: ReplyTimes["why"]): ReplyTimes => ({ startedAt: 1_000, spans: [], callsAt: {}, ended: { reason, at: 4_000 }, ...(why === undefined ? {} : { why }) });
const notFoundWhy = { code: "model-not-found", message: "HTTP 404: model 'x' not found" };
const notFound = { type: "error", ...notFoundWhy, ended: { reason: "failed", at: 4_000 }, question: { ...userMsg("u-A", "A", "hello A"), times: stamped("failed", notFoundWhy) } } as const;
/** The note a row draws, as the timeline shows it; "missing" when the row is not in its chat here. */
const noteOn = (threadId: string, id: string) => {
  const m = st().messages[threadId]?.find((x) => x.id === id);
  return m === undefined ? "missing" : drawTimes(m, undefined).note;
};

beforeEach(async () => {
  b = installBrowser();
  vi.resetModules();
  session = await import("../src/session.ts");
  store = await import("../src/store.ts");
  created = ["A", "B"];
  b.server.answer("threads.create", ({ title }) => ({ id: created.shift() ?? "Z", title: title ?? "", createdAt: 1, updatedAt: 1 }));
  b.server.answer("threads.get", ({ threadId }) => ({ thread: { id: threadId, title: threadId, createdAt: 1, updatedAt: 1 }, messages: [] }));
  b.server.answer("chat.send", ({ threadId, content }) => ({ turnId: `turn-${threadId}`, userMessage: userMsg(`u-${threadId}`, threadId, content) }));
  b.server.answer("chat.cancel", () => ({ cancelled: true }));
  disconnect = session.connect();
  await until(() => st().imageStatus !== undefined && st().conn.kind === "open", 2000, "hydration");
});

afterEach(async () => {
  disconnect?.();
  b.server.accepting = false;
  for (const s of b.server.sockets) s.close();
  await tick();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function answering(id: string): Promise<string> {
  session.newThread();
  void session.send(`hello ${id}`);
  await until(() => typeof st().turns[id]?.turnId === "string" && st().turns[id]?.pendingUser === null, 2000, `the turn in ${id}`);
  return st().turns[id]?.turnId ?? "";
}

it("a failure that lands after Stop, on screen, is the failure and not the Stop", async () => {
  const a = await answering("A");
  session.stop();
  await tick();
  expect(st().turns["A"]?.end).toMatchObject({ kind: "stopped" });
  chat(a, "A", notFound);
  await tick();
  expect(st().turns["A"]?.end).toEqual({ kind: "error", code: "model-not-found", message: notFound.message });
  // the stamped question is in place, and its note waits while the turn shows its own error line
  expect(noteOn("A", "u-A")).toEqual({ kind: "failed", why: notFoundWhy.message });
});

it("a failure that lands after Stop, off screen, leaves its note under the question", async () => {
  const a = await answering("A");
  session.stop();
  await tick();
  await answering("B");
  chat(a, "A", notFound);
  await tick();
  expect(st().turns["A"]).toBeUndefined();
  // the note a failure off screen leaves without a Stop
  expect(noteOn("A", "u-A")).toEqual({ kind: "failed", why: notFoundWhy.message });
});

const cancelled = { type: "error", code: "cancelled", message: "cancelled mid-stream; no done event", ended: { reason: "stopped", at: 4_000 }, question: { ...userMsg("u-A", "A", "hello A"), times: stamped("stopped") } } as const;

it("the server's cancel after Stop, off screen, leaves no note: the Stop says it", async () => {
  const a = await answering("A");
  session.stop();
  await tick();
  await answering("B");
  chat(a, "A", cancelled);
  await tick();
  expect(st().turns["A"]).toBeUndefined();
  expect(noteOn("A", "u-A")).toBeUndefined();
});

it("a Retry took the question out: its turn's late end does not put it back", async () => {
  const a = await answering("A");
  session.stop();
  await tick();
  await answering("B");
  store.setState((s) => ({ messages: { ...s.messages, A: [] } }));
  chat(a, "A", notFound);
  await tick();
  expect(noteOn("A", "u-A")).toBe("missing");
});

// Leaving for a new chat without sending keeps the stopped turn: its end settles it off screen (`settle`).
it("leaving without a send: the server's cancel after Stop leaves no note", async () => {
  const a = await answering("A");
  session.stop();
  await tick();
  session.newThread();
  await tick();
  expect(st().turns["A"]?.end).toMatchObject({ kind: "stopped" });
  chat(a, "A", cancelled);
  await tick();
  expect(st().turns["A"]).toBeUndefined();
  expect(noteOn("A", "u-A")).toBeUndefined();
});

it("leaving without a send: a failure after Stop leaves its note under the question", async () => {
  const a = await answering("A");
  session.stop();
  await tick();
  session.newThread();
  await tick();
  chat(a, "A", notFound);
  await tick();
  expect(st().turns["A"]).toBeUndefined();
  expect(noteOn("A", "u-A")).toEqual({ kind: "failed", why: notFoundWhy.message });
});

it("a failure with saved words after Stop keeps the failure's words, not Stop's seconds", async () => {
  const a = await answering("A");
  chat(a, "A", { type: "delta", text: "Partly" });
  await tick();
  b.frame();
  session.stop();
  await tick();
  const why = { code: "stream-error", message: "stream broke" };
  const partial: Message = { id: "p-A", threadId: "A", role: "assistant", content: "Partly", interrupted: true, createdAt: 2, times: stamped("failed", why) };
  chat(a, "A", { type: "error", ...why, partial, ended: { reason: "failed", at: 4_000 } });
  await tick();
  expect(noteOn("A", "p-A")).toEqual({ kind: "failed", why: "stream broke" });
});

it("a call cut by Stop, kept in this chat without a saved row, is kept as stopped, not failed", async () => {
  const a = await answering("A");
  chat(a, "A", { type: "tool", step: { callId: "c1", name: "shell", state: "running", summary: "Searching your library" } });
  await tick();
  b.frame();
  session.stop();
  await tick();
  chat(a, "A", cancelled);
  await tick();
  // the person moves on: the stopped reply leaves the map and its words stay in its chat
  await answering("B");
  const kept = st().messages["A"]?.find((m) => m.role === "assistant");
  expect(kept?.tools).toMatchObject([{ state: "error", stopped: true }]);
});

it("first words that come after Stop set no first-word time on the saved reply", async () => {
  const a = await answering("A");
  chat(a, "A", { type: "thinking", text: "Hmm" });
  await tick();
  b.frame();
  session.stop();
  await tick();
  const stopped = st().turns["A"]?.end;
  expect(stopped).toMatchObject({ kind: "stopped" });
  // the model's first answer word was already on its way when the cancel landed
  chat(a, "A", { type: "delta", text: "Late" });
  await tick();
  const partial: Message = { id: "p-A", threadId: "A", role: "assistant", content: "", thinking: "Hmm", interrupted: true, createdAt: 2 };
  // the server's clock stopped at the Stop (apps/server/src/chat/times.test.ts): its row has no first-word time
  chat(a, "A", { type: "error", code: "cancelled", message: "cancelled mid-stream; no done event", ended: { reason: "stopped", at: 4_000 },
    partial: { ...partial, times: { ...stamped("stopped"), thoughtMs: 3_000, spans: [{ from: 0, ms: 3_000 }] } } });
  await tick();
  // the work stops at the Stop, not at the late word; the square keeps Stop's seconds
  const row = st().messages["A"]?.find((m) => m.id === "p-A");
  expect(row === undefined ? "missing" : drawTimes(row, undefined)).toMatchObject({ workMs: 3_000, note: { kind: "stopped", secs: 3 } });
});
