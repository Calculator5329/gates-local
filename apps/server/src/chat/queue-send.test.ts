// The server sends its queue: a message queued behind a reply goes when that reply ends and
// leaves the queue at its start; a Stop holds it until Send now.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Channel, type Payload, type QueuedMessage, methods } from "@gates-local/contracts";
import * as S from "effect/Schema";
import { afterEach, expect, it, vi } from "vitest";
import { AppError, createApp } from "../app.ts";
import { openThreadStore } from "../threads/store.ts";

const MODEL = "qwen3.5:9b";
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const clean of cleanups.splice(0).toReversed()) await clean();
});

const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!ok()) throw new Error(`timed out waiting for ${what}`);
};

function rig() {
  const root = path.join(os.homedir(), ".cache", "gates-local-tests");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "queue-send-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = openThreadStore(path.join(dir, "threads.sqlite"));
  const thread = db.createThread({ title: "A" });
  const show: unknown = JSON.parse(readFileSync(new URL("../fit/fixtures/show-qwen3-5-9b.json", import.meta.url), "utf8"));
  /** Each chat request's model and context. */
  const asked: { model: string; numCtx: number }[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const where = new URL(String(url)).pathname;
    if (where === "/api/chat") {
      const body = JSON.parse(String(init?.body)) as { model: string; options: { num_ctx: number } };
      asked.push({ model: body.model, numCtx: body.options.num_ctx });
    }
    if (where === "/api/show") return Response.json(show);
    if (where === "/api/ps") return Response.json({ models: [] });
    if (where === "/api/tags") return Response.json({ models: [{ name: MODEL, size: 6600000000, digest: "d", modified_at: "2026-11-01T00:00:00Z" }] });
    if (where === "/api/chat") return new Response(`${JSON.stringify({ model: MODEL, message: { role: "assistant", content: "ok" }, done: true, done_reason: "stop" })}\n`);
    throw new Error(`Unexpected request: ${where}`);
  });
  // each send's admit waits here: openOne lets the next one through, open lets every one through
  const waiting: (() => void)[] = [];
  let allowed = 0;
  let all = false;
  const pass = () => {
    for (;;) {
      const go = waiting[0];
      if (go === undefined || !(all || allowed > 0)) return;
      if (!all) allowed--;
      waiting.shift();
      go();
    }
  };
  /** The next admits refuse with these, in order. */
  const refusals: Error[] = [];
  const open = () => { all = true; pass(); };
  const openOne = () => { allowed++; pass(); };
  const signal = new AbortController().signal;
  const pushes: Array<{ channel: Channel; payload: unknown }> = [];
  const model = { name: MODEL, digest: "d", sizeBytes: 6_600_000_000, modifiedAt: "2026-11-01T00:00:00Z", capabilities: ["completion" as const] };
  const app = createApp({
    store: db,
    dataDir: dir,
    runtime: { status: () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }), baseUrl: () => "http://fake", onChange: () => () => {}, ensure: async () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }), lookIfDown: async () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }) },
    catalog: { current: () => [model], refresh: async () => ({ models: [model], changed: false }), onChange: () => () => {}, stop: () => {} },
    push: (channel, payload) => { pushes.push({ channel, payload }); },
    fit: { runNvidiaSmi: async (args) => (args[0]?.startsWith("--query-gpu") ? "16384, 1024, 15360\n" : ""), readMeminfo: async () => "MemAvailable: 32000000 kB\n" },
    models: { handlers: {}, loader: { reserve: () => ({
      baseUrl: "http://fake", signal, cold: false, firstToken: () => {}, end: () => {},
      admit: async (_ctx, options) => {
        await new Promise<void>((go) => { waiting.push(go); pass(); });
        const no = refusals.shift();
        if (no !== undefined) throw no;
        if (options?.fit === undefined) throw new Error("missing app fit");
        return options.fit(signal, { handoff: undefined, leave: async () => undefined });
      },
    }) } },
  });
  cleanups.push(async () => { open(); await app.shutdown(); db.close(); });
  const starts = () => pushes.flatMap((p) => {
    const e = (p.payload as Payload<"chat.event">).event;
    return p.channel === "chat.event" && e.type === "start" ? [e.userMessage.content] : [];
  });
  const queued = (): readonly QueuedMessage[] => (pushes.findLast((p) => p.channel === "queue.changed")?.payload ?? []) as readonly QueuedMessage[];
  const entry = (id: string, text: string): QueuedMessage => ({ id, threadId: thread.id, messageId: `m-${id}`, text, at: 1, waitFor: "reply", model: MODEL, numCtx: 16384 });
  return { app, db, thread, open, openOne, refusals, asked, pushes, starts, queued, entry, h: app.handlers as Required<typeof app.handlers> };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

it("a message queued behind a reply goes when that reply ends, and leaves the queue at its start", async () => {
  const r = rig();
  await r.h["chat.send"]({ threadId: r.thread.id, content: "first", model: MODEL, numCtx: 16384 }, { clientId: 1 });
  await r.h["queue.add"](r.entry("q1", "second"), { clientId: 1 });
  await settle();
  expect(r.queued()).toMatchObject([{ id: "q1", text: "second" }]);
  expect(r.starts(), "nothing goes while the reply before it runs").toEqual([]);
  r.open();
  await until(() => r.starts().length === 2 && r.queued().length === 0, "the queued message sent");
  expect(r.starts()).toEqual(["first", "second"]);
  expect(r.db.getMessage("m-q1")?.content).toBe("second");
  expect(await r.h["queue.list"]({}, { clientId: 2 }), "a second window sees the same queue").toEqual([]);
});

it("a Stop before the reply started holds what queued behind it; Send now sends it", async () => {
  const r = rig();
  const { turnId } = await r.h["chat.send"]({ threadId: r.thread.id, content: "first", model: MODEL, numCtx: 16384 }, { clientId: 1 });
  await r.h["queue.add"](r.entry("q1", "second"), { clientId: 1 });
  await r.h["chat.cancel"]({ turnId }, { clientId: 1 });
  r.open();
  await until(() => r.queued()[0]?.held === true, "the queue held");
  await settle();
  expect(r.starts()).toEqual([]);
  await r.h["queue.update"]({ id: "q1", now: true }, { clientId: 2 });
  await until(() => r.starts().length === 1 && r.queued().length === 0, "Send now sent it");
  expect(r.starts()).toEqual(["second"]);
});

it.each(["the hold first, as a window sends them", "the Stop first"])("a Stop that lands just after the reply ended still holds what queued behind it, and pulls back the one already on its way (%s)", async (order) => {
  const r = rig();
  const hold = async (id: string) => r.h["queue.update"]({ id, held: true }, { clientId: 1 });
  const { turnId } = await r.h["chat.send"]({ threadId: r.thread.id, content: "first", model: MODEL, numCtx: 16384 }, { clientId: 1 });
  await r.h["queue.add"](r.entry("q1", "second"), { clientId: 1 });
  await r.h["queue.add"](r.entry("q2", "third"), { clientId: 1 });
  // the reply's last word reaches the server before the Stop: the queue moves on and q1 goes out
  r.openOne();
  await until(() => r.queued()[0]?.sending !== undefined, "the next message on its way");
  expect(r.starts()).toEqual(["first"]);
  // the Stop and the window's holds, a round trip after the reply ended
  if (order === "the Stop first") {
    await r.h["chat.cancel"]({ turnId }, { clientId: 1 });
    await hold("q1");
    await hold("q2");
  } else {
    // q1 is on its way when its hold comes: the hold is answered as too late, the Stop pulls it back
    await expect(hold("q1")).rejects.toMatchObject({ code: "queue-sending" });
    await hold("q2");
    await r.h["chat.cancel"]({ turnId }, { clientId: 1 });
  }
  r.open();
  await settle();
  expect(r.starts(), "nothing behind a stopped reply goes on its own").toEqual(["first"]);
  expect(r.queued().map((q) => [q.id, q.held, q.sending, q.why])).toEqual([["q1", true, undefined, undefined], ["q2", true, undefined, undefined]]);
  expect(r.db.getMessage("m-q1"), "the pulled-back message was never saved").toBeUndefined();
});

it("a Stop long after the reply ended changes nothing", async () => {
  const r = rig();
  r.open();
  const { turnId } = await r.h["chat.send"]({ threadId: r.thread.id, content: "first", model: MODEL, numCtx: 16384 }, { clientId: 1 });
  await until(() => r.starts().length === 1, "the reply");
  await settle();
  await r.h["queue.add"](r.entry("q1", "second"), { clientId: 1 });
  await until(() => r.starts().length === 2, "the queued message sent");
  expect(await r.h["chat.cancel"]({ turnId }, { clientId: 1 })).toEqual({ cancelled: false });
});

it("a row left open in a composer goes on once that window's connection closes", async () => {
  const r = rig();
  r.open();
  const closed = new AbortController();
  await r.h["queue.add"](r.entry("q1", "second"), { clientId: 1 });
  // queued with no reply running would go at once: hold it open in window 3 first
  await r.h["queue.update"]({ id: "q1", editing: true }, { clientId: 3, signal: closed.signal });
  const { turnId } = await r.h["chat.send"]({ threadId: r.thread.id, content: "first", model: MODEL, numCtx: 16384 }, { clientId: 1 });
  void turnId;
  await until(() => r.starts().includes("first"), "the reply");
  await settle();
  expect(r.starts(), "a row open in a composer waits").toEqual(["first"]);
  expect(r.queued()[0]).toMatchObject({ id: "q1", editing: true });
  closed.abort();
  await until(() => r.starts().length === 2, "the row sent once its editor left");
  expect(r.starts()).toEqual(["first", "second"]);
});

it("another window's edit of the same row does not end when the first editor's connection closes", async () => {
  const r = rig();
  const first = new AbortController();
  await r.h["queue.add"](r.entry("q1", "second"), { clientId: 1 });
  await r.h["queue.update"]({ id: "q1", editing: true }, { clientId: 3, signal: first.signal });
  await r.h["queue.update"]({ id: "q1", editing: true }, { clientId: 4, signal: new AbortController().signal });
  first.abort();
  r.open();
  await settle();
  expect(r.queued()[0]).toMatchObject({ id: "q1", editing: true });
  expect(r.starts()).toEqual([]);
});

it("a queued message refused for memory keeps what runs instead, and goes with the context the person picks from it", async () => {
  const r = rig();
  const offer = { context: { numCtx: 8192, verdict: "fits" as const }, short: { needBytes: 2, gpuBytes: 1, ramBytes: 0, shortBytes: 1 } };
  r.refusals.push(Object.assign(new AppError("wont-fit", "qwen3.5:9b at 16k does not fit."), { offer }));
  r.open();
  await r.h["queue.add"](r.entry("q1", "second"), { clientId: 1 });
  await until(() => r.queued()[0]?.held === true, "the refusal");
  expect(r.queued()[0]?.why).toEqual({ code: "wont-fit", message: "qwen3.5:9b at 16k does not fit.", offer });
  // the note's smaller context, then Send now; the wire keeps the context
  const change = S.decodeUnknownSync(methods["queue.update"].params)({ id: "q1", model: MODEL, numCtx: 8192 });
  expect(change).toEqual({ id: "q1", model: MODEL, numCtx: 8192 });
  await r.h["queue.update"](change, { clientId: 1 });
  expect(r.queued()[0]).toMatchObject({ model: MODEL, numCtx: 8192 });
  await r.h["queue.update"]({ id: "q1", now: true }, { clientId: 1 });
  await until(() => r.starts().length === 1, "sent");
  expect(r.asked.at(-1)).toEqual({ model: MODEL, numCtx: 8192 });
});
