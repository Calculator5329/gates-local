// A reply that runs while its chat is not open: it is the same turn, applied by
// the same reducer, as the one on screen, and it costs the open chat nothing
// per word.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Message, Payload } from "@gates-local/contracts";
import { type Browser, installBrowser, tick, until } from "./harness.ts";

let b: Browser;
let session: typeof import("../src/session.ts");
let store: typeof import("../src/store.ts");
let disconnect: (() => void) | undefined;
let created: string[] = [];
let skew = 0;

const st = () => store.getState();
const userMsg = (id: string, threadId: string, content: string): Message => ({ id, threadId, role: "user", content, createdAt: 1 });
const chat = (turnId: string, threadId: string, event: Payload<"chat.event">["event"]) => b.server.push("chat.event", { turnId, threadId, event });

beforeEach(async () => {
  b = installBrowser();
  vi.resetModules();
  skew = 0;
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
  session = await import("../src/session.ts");
  store = await import("../src/store.ts");
  created = ["A", "B"];
  b.server.answer("threads.create", ({ title }) => ({ id: created.shift() ?? "Z", title: title ?? "", createdAt: 1, updatedAt: 1 }));
  b.server.answer("threads.get", ({ threadId }) => ({ thread: { id: threadId, title: threadId, createdAt: 1, updatedAt: 1 }, messages: [] }));
  b.server.answer("chat.send", ({ threadId, content }) => ({ turnId: `turn-${threadId}`, userMessage: userMsg(`u-${threadId}`, threadId, content) }));
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

/** A new chat with this id, answering; the turn id is known when this returns. */
async function answering(id: string): Promise<string> {
  session.newThread();
  void session.send(`hello ${id}`);
  await until(() => typeof st().turns[id]?.turnId === "string" &&st().turns[id]?.pendingUser === null, 2000, `the turn in ${id}`);
  return st().turns[id]?.turnId ?? "";
}

it("shows the time a reply thought, even when it stopped thinking while its chat was not open", async () => {
  const a = await answering("A");
  chat(a, "A", { type: "thinking", text: "Let me think" });
  await tick(); b.frame();
  // the person starts a second chat; A goes on behind it
  await answering("B");
  skew += 5_000;
  chat(a, "A", { type: "delta", text: "First words" });
  await tick(); b.frame();
  // a minute later the person comes back to A, and more words arrive
  skew += 60_000;
  session.openThread("A");
  chat(a, "A", { type: "delta", text: " and more" });
  await tick(); b.frame();
  expect(st().turns["A"]).toMatchObject({ threadId: "A", text: "First words and more" });
  expect(st().turns["A"]?.thinkingSecs, "Thought for: the five seconds before the first word, not the time until the next frame here").toBe(5);
});

it("shows the time a reply thought when the person left before its first word reached the screen", async () => {
  const a = await answering("A");
  chat(a, "A", { type: "thinking", text: "Let me think" });
  await tick(); b.frame();
  skew += 5_000;
  chat(a, "A", { type: "delta", text: "First words" });
  await tick();
  // the person leaves before the frame that would show the word
  session.newThread();
  b.frame();
  skew += 60_000;
  session.openThread("A");
  expect(st().turns["A"]?.text).toBe("First words");
  expect(st().turns["A"]?.thinkingSecs, "the first word arrived after five seconds").toBe(5);
});

it("a reply streaming in a chat that is not open costs the open chat no store update per word", async () => {
  const a = await answering("A");
  await answering("B");
  chat(a, "A", { type: "delta", text: "w0 " });
  await tick(); b.frame();
  let published = 0;
  const off = store.subscribe(() => { published++; });
  try {
    for (let i = 1; i < 200; i++) {
      chat(a, "A", { type: "delta", text: `w${i} ` });
      if (i % 10 === 0) { await tick(); b.frame(); }
    }
    await tick(); b.frame();
  } finally {
    off();
  }
  expect(published, "199 words behind the open chat").toBe(0);
  // they are all there when the person opens that chat
  session.openThread("A");
  expect(st().turns["A"]?.text.split(" ").filter(Boolean)).toHaveLength(200);
});
