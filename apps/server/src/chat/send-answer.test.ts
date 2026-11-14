// chat.send answers once the turn is taken (chat row 32): its id at once, before the fit, the
// load and saving the question. turns.active lists the turn from then. A refusal from then on
// is the turn's error event, the one way every window hears of it.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Channel, Payload } from "@gates-local/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { AppError, createApp } from "../app.ts";
import { openThreadStore } from "../threads/store.ts";

const MODEL = "qwen3.5:9b";
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const clean of cleanups.splice(0).toReversed()) await clean();
});

const noop = (): void => {};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = noop;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!ok()) throw new Error(`timed out waiting for ${what}`);
};

/** The app around a fake loader whose admission waits for `gate`, then runs `admit`. */
function rig(admit: () => Promise<void> = async () => {}) {
  const dir = mkdtempSync(path.join(os.homedir(), ".cache", "gates-local-tests", "send-answer-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = openThreadStore(path.join(dir, "threads.sqlite"));
  const thread = db.createThread({ title: "A" });
  const show: unknown = JSON.parse(readFileSync(new URL("../fit/fixtures/show-qwen3-5-9b.json", import.meta.url), "utf8"));
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    const where = new URL(String(url)).pathname;
    if (where === "/api/show") return Response.json(show);
    if (where === "/api/ps") return Response.json({ models: [] });
    if (where === "/api/tags") return Response.json({ models: [{ name: MODEL, size: 6600000000, digest: "d", modified_at: "2026-11-01T00:00:00Z" }] });
    if (where === "/api/chat") return new Response(`${JSON.stringify({ model: MODEL, message: { role: "assistant", content: "" }, done: true, done_reason: "stop" })}\n`);
    throw new Error(`Unexpected request: ${where}`);
  });
  const gate = deferred();
  const signal = new AbortController().signal;
  const pushes: Array<{ channel: Channel; payload: unknown }> = [];
  const app = createApp({
    store: db,
    runtime: { status: () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }), baseUrl: () => "http://fake", onChange: () => () => {}, ensure: async () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }), lookIfDown: async () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }) },
    catalog: { current: () => [], refresh: async () => ({ models: [], changed: false }), onChange: () => () => {}, stop: () => {} },
    push: (channel, payload) => { pushes.push({ channel, payload }); },
    fit: { runNvidiaSmi: async (args) => (args[0]?.startsWith("--query-gpu") ? "16384, 1024, 15360\n" : ""), readMeminfo: async () => "MemAvailable: 32000000 kB\n" },
    models: { handlers: {}, loader: { reserve: () => ({
      baseUrl: "http://fake", signal, cold: false, firstToken: () => {}, end: () => {},
      admit: async (_ctx, options) => {
        await gate.promise;
        await admit();
        if (options?.fit === undefined) throw new Error("missing app fit");
        return options.fit(signal, { handoff: undefined, leave: async () => undefined });
      },
    }) } },
  });
  cleanups.push(async () => { gate.resolve(); await app.shutdown(); db.close(); });
  const events = (turnId: string) => pushes
    .filter((p) => p.channel === "chat.event" && (p.payload as Payload<"chat.event">).turnId === turnId)
    .map((p) => (p.payload as Payload<"chat.event">).event);
  return { app, db, thread, gate, events };
}

it("chat.send answers with the turn id while the turn waits to be admitted, and turns.active lists it from then", async () => {
  mkdirSync(path.join(os.homedir(), ".cache", "gates-local-tests"), { recursive: true });
  const r = rig();
  const sending = Promise.resolve(r.app.handlers["chat.send"]({ threadId: r.thread.id, content: "hi", model: MODEL, numCtx: 16384 }, { clientId: 1 }));
  const answer = await Promise.race([sending, new Promise<"waiting">((done) => setTimeout(() => done("waiting"), 300))]);
  if (answer === "waiting") throw new Error("chat.send waited for the admission");
  expect(answer).toEqual({ turnId: expect.any(String) });
  expect(r.events(answer.turnId), "nothing has started yet").toEqual([]);
  const listActive = r.app.handlers["turns.active"];
  if (listActive === undefined) throw new Error("the server has no turns.active");
  expect(await listActive({}, { clientId: 2 }), "another window sees the reply coming").toEqual([{ turnId: answer.turnId, threadId: r.thread.id }]);
  r.gate.resolve();
  await until(() => r.events(answer.turnId).some((e) => e.type === "start"), "the start");
  expect(r.events(answer.turnId)[0]).toMatchObject({ type: "start", model: MODEL, userMessage: { role: "user", content: "hi" } });
});

it("a refusal after the answer is the turn's error event, before any start, with the turns in the way", async () => {
  mkdirSync(path.join(os.homedir(), ".cache", "gates-local-tests"), { recursive: true });
  const blocking = [{ threadId: "B", title: "B", model: "gemma3:4b", turnId: "turn-b" }];
  const r = rig(async () => { throw new AppError("would-stop", "needs the GPU memory of a running reply", undefined, undefined, blocking); });
  const answer = await r.app.handlers["chat.send"]({ threadId: r.thread.id, content: "hi", model: MODEL, numCtx: 16384, askFirst: true }, { clientId: 1 });
  r.gate.resolve();
  await until(() => r.events(answer.turnId).length > 0, "the refusal");
  expect(r.events(answer.turnId)).toEqual([{ type: "error", code: "would-stop", message: "needs the GPU memory of a running reply", blocking, ended: { reason: "failed", at: expect.any(Number) } }]);
  expect(r.db.getThread(r.thread.id).messages, "the question was not saved").toEqual([]);
  await until(() => r.app.activeTurns() === 0, "the turn to go");
});

it("a Stop before the turn started ends it as stopped, with nothing saved", async () => {
  mkdirSync(path.join(os.homedir(), ".cache", "gates-local-tests"), { recursive: true });
  const r = rig();
  const answer = await r.app.handlers["chat.send"]({ threadId: r.thread.id, content: "hi", model: MODEL, numCtx: 16384 }, { clientId: 1 });
  expect(r.app.handlers["chat.cancel"]({ turnId: answer.turnId }, { clientId: 1 })).toEqual({ cancelled: true });
  r.gate.resolve();
  await until(() => r.events(answer.turnId).length > 0, "the end");
  expect(r.events(answer.turnId)).toEqual([{ type: "error", code: "cancelled", message: "the turn was cancelled before it started", ended: { reason: "stopped", at: expect.any(Number) } }]);
  expect(r.db.getThread(r.thread.id).messages).toEqual([]);
});
