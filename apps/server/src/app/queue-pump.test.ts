import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message } from "@gates-local/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { entry, waits } from "../chat/queue-testing.ts";
import { endOf } from "../chat/send-started.ts";
import { createReplies, type Ready, type Replies } from "../chat/replies.ts";
import type { RuntimeState, RuntimeStatus } from "../runtime/types.ts";
import { openThreadStore, type ThreadStore } from "../threads/store.ts";
import { chatCatalog } from "../../test/send-rig.ts";
import { createQueuePump, type QueuePumpDeps } from "./queue-pump.ts";

const MODEL = "qwen3.5:9b";
const idle: Ready = { chat: true, anyWork: false, busy: () => false };
const READY: RuntimeStatus = { state: "ready", owner: "external", baseUrl: "http://fake" };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const clean of cleanups.splice(0).toReversed()) await clean();
});

const turnover = () => new Promise<void>((done) => { setImmediate(done); });

async function turnsOver(times: number): Promise<void> {
  for (let i = 0; i < times; i++) await turnover();
}

const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!ok()) throw new Error(`timed out waiting for ${what}`);
};

const asked = (id: string, threadId: string, content: string): Message => ({ id, threadId, role: "user", content, createdAt: 1 });

type Begin = QueuePumpDeps["begin"];

function pumpRig(saved: ReadonlyMap<string, Message> = new Map()) {
  const q = createReplies({
    file: undefined, log: () => {}, told: () => {}, saved: (id) => saved.get(id), deleting: () => false, closing: () => false,
    cut: () => undefined, clock: () => undefined,
  });
  let picks = 0;
  const replies: Replies = { ...q, pick: (ready) => { picks++; return q.pick(ready); } };
  const begun: string[] = [];
  let begin: Begin = (params, taken) => {
    begun.push(params.content);
    return { turnId: taken.turnId };
  };
  let turns = 0;
  const pump = createQueuePump({
    replies, turns: new Map(), byThread: new Map(), closing: () => false, settings: undefined,
    store: { getMessage: (id: string) => saved.get(id) } as unknown as ThreadStore,
    catalog: chatCatalog(MODEL),
    runtime: { status: () => READY, baseUrl: () => "http://fake", onChange: () => () => {}, ensure: async () => READY, lookIfDown: async () => READY },
    newId: () => `turn-${++turns}`,
    begin: (params, taken) => begin(params, taken),
  });
  return {
    q, pump, begun,
    picks: () => picks,
    beginWith: (next: Begin) => { begin = next; },
  };
}

it("many looks at the queue in one moment become a single look", async () => {
  const r = pumpRig();
  r.pump.pump();
  r.pump.pump();
  r.pump.pump();
  expect(r.picks(), "nothing is looked at before the current work settles").toBe(0);
  await turnsOver(4);
  expect(r.picks()).toBe(1);
});

it("a look at the queue waits for the current work to settle, so a message that starts waiting just after still goes", async () => {
  const r = pumpRig();
  r.pump.pump();
  waits(r.q, entry("a"));
  await turnsOver(4);
  expect(r.begun).toEqual(["a"]);
});

it("the pump begins one waiting message at a time: another look while a start is under way begins nothing more", async () => {
  const r = pumpRig();
  const held: (() => void)[] = [];
  r.beginWith((params, taken) => {
    r.begun.push(params.content);
    return new Promise((done) => { held.push(() => done({ turnId: taken.turnId })); });
  });
  waits(r.q, entry("a", "t1"));
  waits(r.q, entry("b", "t2"));
  r.pump.pump();
  await until(() => r.begun.length === 1, "the first start");
  r.pump.pump();
  await turnsOver(4);
  expect(r.begun, "the second waits while the first is starting").toEqual(["a"]);
  held.shift()?.();
  await until(() => r.begun.length === 2, "the second start");
  expect(r.begun).toEqual(["a", "b"]);
});

it("a waiting message whose question is already in the chat is marked sent and not begun again; the next one goes", async () => {
  const saved = new Map<string, Message>();
  const r = pumpRig(saved);
  waits(r.q, entry("a", "t1"));
  waits(r.q, entry("b", "t2"));
  saved.set("m-a", asked("m-a", "t1", "a"));
  r.pump.pump();
  await until(() => r.begun.length === 1, "a start");
  await turnsOver(4);
  expect(r.begun).toEqual(["b"]);
  expect(r.q.records().map((l) => l.reply.id), "the sent one waits no more").toEqual(["b"]);
});

it("a start that finds its question already in the chat answers with that question, and its message is marked sent instead of held", async () => {
  const r = pumpRig();
  const question = asked("m-a", "t1", "a");
  r.beginWith(() => ({ turnId: "saved-m-a", userMessage: question, replayed: true }));
  waits(r.q, entry("a", "t1"));
  const picked = r.q.pick(idle);
  if (picked === undefined) throw new Error("nothing was picked");
  const attempt = r.q.take(picked.id, "turn-1", 1);
  if (attempt === undefined) throw new Error("the message was not taken");
  expect(await r.pump.start(picked, "turn-1", attempt)).toEqual({ asked: question });
  expect(r.q.records(), "neither starting nor held").toEqual([]);
  expect(r.q.pick(idle)).toBeUndefined();
});

function appRig(start: RuntimeState) {
  const root = path.join(os.homedir(), ".cache", "gates-local-tests");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "queue-pump-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = openThreadStore(path.join(dir, "threads.sqlite"));
  const thread = db.createThread({ title: "A" });
  const show: unknown = JSON.parse(readFileSync(new URL("../fit/fixtures/show-qwen3-5-9b.json", import.meta.url), "utf8"));
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    const where = new URL(String(url)).pathname;
    if (where === "/api/show") return Response.json(show);
    if (where === "/api/ps") return Response.json({ models: [] });
    if (where === "/api/tags") return Response.json({ models: [{ name: MODEL, size: 6600000000, digest: "d", modified_at: "2026-11-01T00:00:00Z" }] });
    if (where === "/api/chat") return new Response(`${JSON.stringify({ model: MODEL, message: { role: "assistant", content: "ok" }, done: true, done_reason: "stop" })}\n`);
    throw new Error(`Unexpected request: ${where}`);
  });
  let state = start;
  const status = (): RuntimeStatus => ({ state, owner: "external", baseUrl: "http://fake" });
  const listeners: ((status: RuntimeStatus) => void)[] = [];
  const signal = new AbortController().signal;
  let admitted!: (ended: Promise<void>) => void;
  /** The end of send `q1`'s turn, read when the loader admits it. */
  const q1Ended = new Promise<void>((resolve) => (admitted = resolve));
  const app = createApp({
    store: db,
    runtime: {
      status, baseUrl: () => "http://fake", ensure: async () => status(), lookIfDown: async () => status(),
      onChange: (listener) => { listeners.push(listener); return () => {}; },
    },
    catalog: chatCatalog(MODEL),
    push: () => {},
    fit: { runNvidiaSmi: async (args) => (args[0]?.startsWith("--query-gpu") ? "16384, 1024, 15360\n" : ""), readMeminfo: async () => "MemAvailable: 32000000 kB\n" },
    models: { handlers: {}, loader: { reserve: () => ({
      baseUrl: "http://fake", signal, cold: false, firstToken: () => {}, end: () => {},
      admit: async (_ctx, options) => {
        admitted(endOf(app, "q1"));
        if (options?.fit === undefined) throw new Error("missing app fit");
        return options.fit(signal, { handoff: undefined, leave: async () => undefined });
      },
    }) } },
  });
  cleanups.push(async () => { await app.shutdown(); db.close(); });
  const change = (next: RuntimeState) => {
    state = next;
    for (const listener of listeners) listener(status());
  };
  return { app, db, thread, change, q1Ended };
}

it("a message typed while Ollama is still being set up goes as soon as the runtime turns ready, with nothing else happening", async () => {
  const r = appRig("installing");
  const ctx = { clientId: 1 };
  const answer = await r.app.handlers["reply.send"]({ id: "q1", threadId: r.thread.id, messageId: "m-q1", text: "hello", model: MODEL, numCtx: 16384 }, ctx);
  expect(answer).toMatchObject({ answer: "done", reply: { stage: "queued" } });
  await turnsOver(4);
  expect(r.db.getMessage("m-q1"), "nothing goes while Ollama is being set up").toBeUndefined();
  r.change("ready");
  await r.q1Ended;
  expect(r.db.getThread(r.thread.id).messages.map((m) => [m.role, m.content])).toEqual([["user", "hello"], ["assistant", "ok"]]);
});
