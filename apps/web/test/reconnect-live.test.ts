import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Message, Payload } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { type Browser, installBrowser, tick, until } from "./harness.ts";

let browser: Browser;
let session: typeof import("../src/session.ts");
let store: typeof import("../src/store.ts");
let disconnect: (() => void) | undefined;
const question: Message = { id: "question", threadId: "t1", role: "user", content: "Explain this long-running question", createdAt: 1 };
const history = (messages: Message[]) => ({ thread: methodSamples["threads.create"].result, messages });
const chat = (event: Payload<"chat.event">["event"]) => browser.server.push("chat.event", { threadId: "t1", turnId: "turn-live", event });

beforeEach(async () => {
  browser = installBrowser();
  vi.resetModules();
  session = await import("../src/session.ts");
  store = await import("../src/store.ts");
  browser.server.answer("threads.get", () => history([question]));
  browser.server.answer("chat.send", () => ({ turnId: "turn-live", userMessage: question }));
  disconnect = session.connect();
  await until(() => store.getState().imageStatus !== undefined);
  await session.send(question.content);
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

async function dropConnection() {
  const batch = browser.server.hold("models.list");
  const thread = browser.server.hold("threads.get");
  const before = browser.server.sockets.length;
  browser.server.socket.close();
  await until(() => browser.server.sockets.length > before);
  return { batch: await batch, thread };
}

function replay() {
  const live = store.getState().live;
  if (live === null) throw new Error("No retained live turn");
  chat({ type: "start", model: live.model, userMessage: question });
  chat({ type: "thinking", text: "server thoughts" });
  chat({ type: "tool", step: { callId: "server-read", name: "read", state: "done", summary: "Read on the server" } });
  chat({ type: "delta", text: "one two " });
}

it("TE-03: replay revives a closed reply, replaces its snapshot once and survives the hydration history load", async () => {
  const held = await dropConnection();
  expect(store.getState().live?.end).toMatchObject({ kind: "error", code: "closed" });
  replay(); // buffered behind the reconnect's first hydration batch
  held.batch.respond(methodSamples["models.list"].result);
  const reload = await held.thread;
  await tick(); browser.frame();
  expect.soft(store.streamingHere(store.getState())).toBe(true);
  expect.soft(store.getState().live).toMatchObject({ turnId: "turn-live", text: "one two ", thinking: "server thoughts", tools: [{ callId: "server-read" }] });
  expect.soft(store.getState().live?.end).toBeUndefined();
  expect.soft(store.getState().runningTurns["t1"]).toBe("turn-live");
  // An assistant card after the question must not make savedReplyFor clear a
  // turn whose replay just proved it is still alive.
  reload.respond(history([question, { id: "image", threadId: "t1", role: "assistant", content: "", createdAt: 2,
    imageJob: { jobId: "image", threadId: "t1", state: "queued" } }]));
  await tick();
  chat({ type: "delta", text: "three " });
  await tick(); browser.frame();
  expect.soft(store.getState().live?.text).toBe("one two three ");
  expect.soft(store.getState().live?.tools).toHaveLength(1);
  session.stop();
  await tick();
  expect(browser.server.calls("chat.cancel").map((call) => call.params)).toEqual([{ turnId: "turn-live" }]);
});

it("TE-03: a reply with no replay keeps its closed state and partial words", async () => {
  const held = await dropConnection();
  held.batch.respond(methodSamples["models.list"].result);
  (await held.thread).respond(history([question]));
  await tick(); browser.frame();
  expect(store.getState().live).toMatchObject({ turnId: "turn-live", text: "one ", end: { kind: "error", code: "closed" } });
  expect(store.streamingHere(store.getState())).toBe(false);
  expect(store.getState().runningTurns).toEqual({});
});

it("TE-03: replay cannot revive a locally stopped reply", async () => {
  session.stop();
  const held = await dropConnection();
  replay();
  held.batch.respond(methodSamples["models.list"].result);
  (await held.thread).respond(history([question]));
  await tick(); browser.frame();
  expect(store.getState().live).toMatchObject({ turnId: "turn-live", text: "one ", end: { kind: "stopped" } });
  expect(store.streamingHere(store.getState())).toBe(false);
  expect(store.getState().runningTurns).toEqual({});
});

it("TE-03: a completed reply with no replay still replaces the closed partial from saved history", async () => {
  const held = await dropConnection();
  held.batch.respond(methodSamples["models.list"].result);
  (await held.thread).respond(history([question, { id: "answer", threadId: "t1", role: "assistant", content: "one two three", createdAt: 2 }]));
  await tick();
  expect(store.getState().live).toBeNull();
  expect(store.getState().messages["t1"]?.at(-1)?.content).toBe("one two three");
});
