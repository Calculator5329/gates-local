import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Message } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { type Browser, installBrowser, tick, until } from "../../../test/harness.ts";
import type { TurnSaid } from "@gates-local/server/app/turn.ts";

let browser: Browser;
let session: typeof import("./index.ts");
let store: typeof import("../store/store.ts");
let disconnect: (() => void) | undefined;
const question: Message = { id: "question", threadId: "t1", role: "user", content: "Explain this long-running question", createdAt: 1 };
const history = (messages: Message[]) => ({ thread: methodSamples["threads.create"].result, messages });
const chat = (event: TurnSaid["event"]) => browser.server.push("turn", { threadId: "t1", turnId: "turn-live", event });

beforeEach(async () => {
  browser = installBrowser();
  vi.resetModules();
  session = await import("./index.ts");
  store = await import("../store/store.ts");
  browser.server.answer("threads.get", () => history([question]));
  browser.server.answer("turn.start", () => ({ turnId: "turn-live", userMessage: question }));
  disconnect = session.connect();
  await until(() => store.getState().imageStatus !== undefined);
  await session.send(question.content);
  // the turn's start, which the server sends after the answer and before any word
  await tick();
  chat({ type: "thinking", text: "local thoughts" });
  chat({ type: "tool", step: { callId: "local-read", name: "read", state: "done", summary: "Read before disconnect" } });
  chat({ type: "delta", text: "one " });
  await tick(); browser.frame();
});

afterEach(async () => {
  disconnect?.();
  browser.server.accepting = false;
  for (const socket of browser.server.sockets) socket.close();
  await tick();
  vi.unstubAllGlobals();
});

/** `whileDown`: what the server does after the socket closes and before the window connects again. */
async function dropConnection(whileDown?: () => void) {
  const batch = browser.server.hold("models.list");
  const thread = browser.server.hold("threads.get");
  const before = browser.server.sockets.length;
  browser.server.socket.close();
  whileDown?.();
  await until(() => browser.server.sockets.length > before);
  return { batch: await batch, thread };
}

/** The open chat's turn (what the old single live slot showed), or null. */
const openTurn = () => { const s = store.getState(); return s.threadId === null ? null : s.turns[s.threadId] ?? null; };

/** The words the server's turn writes while this window's connection is down. */
function writtenUnheard() {
  browser.server.unheard(() => {
    chat({ type: "thinking", text: " and server thoughts" });
    chat({ type: "tool", step: { callId: "server-read", name: "read", state: "done", summary: "Read on the server" } });
    chat({ type: "delta", text: "two " });
  });
}

it("TE-03: a reply goes on through a dropped connection: the list's words so far replace the window's once, and survive the hydration history load", async () => {
  const held = await dropConnection(writtenUnheard);
  // the window does not end a reply on its own: the server's record says whether it still runs
  expect(openTurn()).toMatchObject({ text: "one " });
  expect(openTurn()?.end).toBeUndefined();
  chat({ type: "delta", text: "three " }); // pushed behind the reconnect's first hydration batch
  held.batch.respond(methodSamples["models.list"].result);
  const reload = await held.thread;
  await tick(); browser.frame();
  expect.soft(store.streamingHere(store.getState())).toBe(true);
  expect.soft(openTurn()).toMatchObject({ turnId: browser.server.replyOf("turn-live"), text: "one two three ", thinking: "local thoughts and server thoughts" });
  expect.soft(openTurn()?.tools.map((t) => t.callId)).toEqual(["local-read", "server-read"]);
  expect.soft(openTurn()?.end).toBeUndefined();
  expect.soft(store.getState().turns["t1"]?.turnId).toBe(browser.server.replyOf("turn-live"));
  expect.soft(store.runningThreads(store.getState()).has("t1")).toBe(true);
  // An assistant card after the question must not make savedReplyFor clear a
  // turn the server's list just said is still running.
  reload.respond(history([question, { id: "image", threadId: "t1", role: "assistant", content: "", createdAt: 2,
    imageJob: { jobId: "image", threadId: "t1", state: "queued" } }]));
  await tick();
  chat({ type: "delta", text: "four " });
  await tick(); browser.frame();
  expect.soft(openTurn()?.text).toBe("one two three four ");
  expect.soft(openTurn()?.tools).toHaveLength(2);
  session.stop();
  await tick();
  expect(browser.server.calls("reply.stop").map((call) => call.params)).toEqual([{ id: browser.server.replyOf("turn-live") }]);
});

it("TE-03: a reply the server lists as still running takes the list's words in place of its own, not doubled", async () => {
  // the server's list of records names the reply: nothing ended it
  const held = await dropConnection(writtenUnheard);
  held.batch.respond(methodSamples["models.list"].result);
  (await held.thread).respond(history([question]));
  await tick(); browser.frame();
  expect(store.runningThreads(store.getState()).has("t1")).toBe(true);
  expect(openTurn()).toMatchObject({ turnId: browser.server.replyOf("turn-live"), text: "one two ", thinking: "local thoughts and server thoughts" });
  chat({ type: "delta", text: "three " });
  await tick(); browser.frame();
  expect(openTurn()?.text).toBe("one two three ");
});

it("TE-03: a reply that ended unheard, with nothing saved, is running no more once the server's list leaves it out", async () => {
  // it broke as the connection went: no window heard, and the list at the reconnect names it no more
  browser.server.unheard(() => chat({ type: "error", code: "internal", message: "the runner went away", ended: { reason: "failed", at: 5 } }));
  const held = await dropConnection();
  held.batch.respond(methodSamples["models.list"].result);
  (await held.thread).respond(history([question]));
  await tick(); browser.frame();
  expect(openTurn()?.end === undefined && openTurn() !== null).toBe(false);
  expect(store.getState().messages["t1"]?.map((m) => m.id)).toEqual(["question"]);
  expect(store.streamingHere(store.getState())).toBe(false);
  expect(store.runningThreads(store.getState()).size).toBe(0);
});

it("TE-03: words after a Stop cannot revive a reply the server stopped", async () => {
  session.stop();
  // the server's record of the Stop reaches this window before the connection drops
  await tick();
  const held = await dropConnection();
  chat({ type: "delta", text: "two " });
  held.batch.respond(methodSamples["models.list"].result);
  (await held.thread).respond(history([question]));
  await tick(); browser.frame();
  expect(openTurn()).toMatchObject({ turnId: browser.server.replyOf("turn-live"), text: "one ", end: { kind: "stopped" } });
  expect(store.streamingHere(store.getState())).toBe(false);
  expect(store.runningThreads(store.getState()).size).toBe(0);
});

it("TE-03: a reply completed unheard still replaces the closed partial from saved history", async () => {
  const answer: Message = { id: "answer", threadId: "t1", role: "assistant", content: "one two three", createdAt: 2 };
  // it finished as the connection went: no window heard, and the list at the reconnect names it no more
  browser.server.unheard(() => chat({ type: "done", message: answer, stopReason: "stop" }));
  const held = await dropConnection();
  held.batch.respond(methodSamples["models.list"].result);
  (await held.thread).respond(history([question, answer]));
  await tick();
  expect(openTurn()).toBeNull();
  expect(store.getState().messages["t1"]?.at(-1)?.content).toBe("one two three");
});
