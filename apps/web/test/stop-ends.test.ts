// What a Stop leaves behind when the server's end comes after it: only an
// abort-shaped end is the Stop; a real failure that lands after it is said,
// on screen or off it, and words that come after the Stop change no time.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Message, Payload } from "@gates-local/contracts";
import { type Browser, installBrowser, tick, until } from "./harness.ts";

let b: Browser;
let session: typeof import("../src/session.ts");
let store: typeof import("../src/store.ts");
let disconnect: (() => void) | undefined;
let created: string[] = [];

const st = () => store.getState();
const userMsg = (id: string, threadId: string, content: string): Message => ({ id, threadId, role: "user", content, createdAt: 1 });
const chat = (turnId: string, threadId: string, event: Payload<"chat.event">["event"]) => b.server.push("chat.event", { turnId, threadId, event });
const notFound = { type: "error", code: "model-not-found", message: "HTTP 404: model 'x' not found" } as const;

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
  expect(st().stopNotes["u-A"]).toEqual({ kind: "said", words: "The reply didn't finish." });
});

it("the server's cancel after Stop, off screen, leaves no note: the Stop says it", async () => {
  const a = await answering("A");
  session.stop();
  await tick();
  await answering("B");
  chat(a, "A", { type: "error", code: "cancelled", message: "cancelled mid-stream; no done event" });
  await tick();
  expect(st().turns["A"]).toBeUndefined();
  expect(st().stopNotes["u-A"]).toBeUndefined();
});

// Leaving for a new chat without sending keeps the stopped turn: its end settles it off screen (`settle`).
it("leaving without a send: the server's cancel after Stop leaves no note", async () => {
  const a = await answering("A");
  session.stop();
  await tick();
  session.newThread();
  await tick();
  expect(st().turns["A"]?.end).toMatchObject({ kind: "stopped" });
  chat(a, "A", { type: "error", code: "cancelled", message: "cancelled mid-stream; no done event" });
  await tick();
  expect(st().turns["A"]).toBeUndefined();
  expect(st().stopNotes["u-A"]).toBeUndefined();
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
  expect(st().stopNotes["u-A"]).toEqual({ kind: "said", words: "The reply didn't finish." });
});

it("a failure with saved words after Stop keeps the failure's words, not Stop's seconds", async () => {
  const a = await answering("A");
  chat(a, "A", { type: "delta", text: "Partly" });
  await tick();
  b.frame();
  session.stop();
  await tick();
  const partial: Message = { id: "p-A", threadId: "A", role: "assistant", content: "Partly", interrupted: true, createdAt: 2 };
  chat(a, "A", { type: "error", code: "stream-error", message: "stream broke", partial });
  await tick();
  expect(st().stopNotes["p-A"]).toEqual({ kind: "said", words: "The reply didn't finish. Stream broke." });
});

it("a call cut by Stop, kept in this chat without a saved row, is kept as stopped, not failed", async () => {
  const a = await answering("A");
  chat(a, "A", { type: "tool", step: { callId: "c1", name: "shell", state: "running", summary: "Searching your library" } });
  await tick();
  b.frame();
  session.stop();
  await tick();
  chat(a, "A", { type: "error", code: "cancelled", message: "cancelled mid-stream; no done event" });
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
  chat(a, "A", { type: "error", code: "cancelled", message: "cancelled mid-stream; no done event", partial });
  await tick();
  // the pill would read the late word's time; the square keeps Stop's seconds, the only time shown
  expect(st().firstToken["p-A"]).toBeUndefined();
  expect(st().stopNotes["p-A"]).toEqual(stopped);
});
