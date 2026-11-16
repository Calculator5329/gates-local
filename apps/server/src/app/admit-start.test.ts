import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BlockingTurn, Channel } from "@gates-local/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { sendTaken } from "../chat/send-started.ts";
import type { ReplyRecord } from "../chat/times.ts";
import { openThreadStore } from "../threads/store.ts";
import { chatCatalog, MODEL, settle, until } from "../../test/send-rig.ts";
import type { TurnEvent, TurnSaid } from "./turn.ts";

const OTHER = "gemma3:12b";
const ctx = { clientId: 1 };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).toReversed()) await clean();
  vi.unstubAllGlobals();
});

interface RigOptions {
  readonly cold?: boolean;
  readonly resident?: boolean;
  readonly drip?: boolean;
  readonly ownersRead?: () => void;
  readonly reserved?: () => void;
}

const line = (content: string, done: boolean) => new TextEncoder().encode(`${JSON.stringify({ model: MODEL, message: { role: "assistant", content }, done, ...(done ? { done_reason: "stop" } : {}) })}\n`);

function heldStream(stop: AbortSignal | null | undefined): Response {
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(line("some words", false));
    stop?.addEventListener("abort", () => controller.error(stop.reason), { once: true });
  } }));
}

const noop = (): void => {};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = noop;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function rig(options: RigOptions = {}) {
  const root = path.join(os.homedir(), ".cache", "gates-local-tests");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "admit-start-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = openThreadStore(path.join(dir, "threads.sqlite"));
  const thread = db.createThread({ title: "A" });
  const show: unknown = JSON.parse(readFileSync(new URL("../fit/fixtures/show-qwen3-5-9b.json", import.meta.url), "utf8"));
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const where = new URL(String(url)).pathname;
    if (where === "/api/show") return Response.json(show);
    if (where === "/api/ps") return Response.json({ models: options.resident === true ? [{ name: MODEL, size: 9_000_000_000, size_vram: 9_000_000_000, context_length: 16384 }] : [] });
    if (where === "/api/tags") return Response.json({ models: [MODEL, OTHER].map((name) => ({ name, size: 6600000000, digest: name, modified_at: "2026-11-01T00:00:00Z" })) });
    if (where === "/api/chat") {
      asked.push(String(init?.body));
      return options.drip === true ? heldStream(init?.signal) : new Response(line("ok", true));
    }
    throw new Error(`Unexpected request: ${where}`);
  });
  let gpuReads = 0;
  const gate = deferred();
  const signal = new AbortController().signal;
  const said: TurnSaid[] = [];
  const pushes: { channel: Channel; payload: unknown }[] = [];
  const readsAtStart = new Map<string, number>();
  const store = new Proxy(db, { get: (target, key) => key === "fileOwners" ? () => { options.ownersRead?.(); return target.fileOwners(); } : Reflect.get(target, key, target) });
  const app = createApp({
    store,
    dataDir: dir,
    runtime: { status: () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }), baseUrl: () => "http://fake", onChange: () => () => {}, ensure: async () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }), lookIfDown: async () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }) },
    catalog: chatCatalog(),
    push: (channel, payload) => { pushes.push({ channel, payload }); },
    turnSaid: (s) => {
      said.push(s);
      if (s.event.type === "start") readsAtStart.set(s.turnId, gpuReads);
    },
    fit: {
      runNvidiaSmi: async (args) => {
        if (!args[0]?.startsWith("--query-gpu")) return "";
        gpuReads++;
        return "16384, 1024, 15360\n";
      },
      readMeminfo: async () => "MemAvailable: 32000000 kB\n",
    },
    models: { handlers: {}, loader: { reserve: () => {
      options.reserved?.();
      return {
        baseUrl: "http://fake", signal, cold: options.cold === true, firstToken: () => {}, end: () => {},
        admit: async (_numCtx, admitOptions) => {
          await gate.promise;
          if (admitOptions?.fit === undefined) throw new Error("missing app fit");
          return admitOptions.fit(signal, { handoff: undefined, leave: async () => undefined });
        },
      };
    } } },
  });
  cleanups.push(async () => { gate.resolve(); await app.shutdown(); db.close(); });
  const events = (turnId: string): TurnEvent[] => said.flatMap((s) => s.turnId === turnId ? [s.event] : []);
  const tables = () => pushes.filter((p) => p.channel === "fit.changed").length;
  return { app, db, dir, thread, asked, said, events, tables, gpuReads: () => gpuReads, readsAtStart: (turnId: string) => readsAtStart.get(turnId), open: gate.resolve, h: app.handlers as Required<typeof app.handlers> };
}

const sent = (r: ReturnType<typeof rig>, content: string, extra: { files?: readonly { path: string; name: string; size: number; type: string }[] } = {}) =>
  sendTaken(r.app, { threadId: r.thread.id, content, model: MODEL, numCtx: 16384, messageId: `m-${content.length}`, ...extra }, ctx);

const started = (r: ReturnType<typeof rig>, turnId: string) => until(() => r.events(turnId).some((e) => e.type === "start"), "the start");

async function recordAtStart(cold: boolean): Promise<ReplyRecord | undefined> {
  const r = rig({ cold });
  r.open();
  const { turnId } = await sent(r, "hi");
  await started(r, turnId);
  const events = r.events(turnId);
  const after = events.slice(events.findIndex((e) => e.type === "start")).find((e) => e.type === "reply");
  return after?.type === "reply" ? after.reply : undefined;
}

it("a text-only message too long for the model's context is still taken in, and fails in its reply instead", async () => {
  const r = rig();
  r.open();
  const long = "word ".repeat(30_000);
  const { turnId } = await sent(r, long);
  await until(() => r.events(turnId).some((e) => e.type === "error" || e.type === "done"), "the reply's end");
  expect(r.events(turnId).filter((e) => e.type !== "reply").map((e) => e.type === "error" ? e.code : e.type)).toEqual(["start", "context-too-small"]);
  expect(r.db.getThread(r.thread.id).messages[0]).toMatchObject({ role: "user", content: long });
  expect(r.asked, "the model was never asked").toEqual([]);
});

it("a file swept while its message is being saved is refused in words, and the message is not saved", async () => {
  let reads = 0;
  let copy: string | undefined;
  const r = rig({ ownersRead: () => {
    reads++;
    if (reads === 2 && copy !== undefined) rmSync(copy);
  } });
  const file = await r.h["files.attach"]({ name: "notes.txt", type: "text/plain", data: "aGVsbG8=" }, ctx);
  copy = path.join(r.dir, file.path);
  r.open();
  const { turnId } = await sent(r, "read this", { files: [file] });
  await until(() => r.events(turnId).some((e) => e.type === "error" || e.type === "done"), "the end");
  expect(reads, "checked at the start and again in the save").toBe(2);
  expect(r.events(turnId).filter((e) => e.type !== "reply")).toEqual([{ type: "error", code: "image-input", message: "notes.txt is no longer attached. Attach it again; your words are kept.", ended: { reason: "failed", at: expect.any(Number) } }]);
  expect(r.db.getThread(r.thread.id).messages).toEqual([]);
});

it("a reply whose model loads cold is still loading at its start; one whose model is in memory is ready from its start", async () => {
  const cold = await recordAtStart(true);
  expect(cold).toMatchObject({ stage: "loading" });
  expect(cold?.readyAt).toBeUndefined();
  const warm = await recordAtStart(false);
  expect(warm).toMatchObject({ stage: "waiting", readyAt: expect.any(Number) });
});

it("the fit table built when a reply starts takes the GPU reading its plan has just made", async () => {
  const r = rig({ drip: true });
  r.open();
  const tablesBefore = r.tables();
  const { turnId } = await sent(r, "hi");
  await started(r, turnId);
  const reads = r.readsAtStart(turnId);
  expect(reads, "the plan read the GPU").toBeGreaterThan(0);
  await until(() => r.tables() > tablesBefore, "the table built at the start");
  expect(r.gpuReads(), "no second reading").toBe(reads);
});

it("a reply whose fit has passed is in the way of another model's load already while its question is being saved", async () => {
  const blocking: Promise<readonly BlockingTurn[]>[] = [];
  const r = rig({ resident: true, ownersRead: () => { blocking.push(Promise.resolve(r.h["turns.blocking"]({ model: OTHER, numCtx: 16384 }, ctx))); } });
  const file = await r.h["files.attach"]({ name: "notes.txt", type: "text/plain", data: "aGVsbG8=" }, ctx);
  r.open();
  const { turnId } = await sent(r, "read this", { files: [file] });
  await started(r, turnId);
  expect(blocking).toHaveLength(2);
  expect(await blocking[0], "before its fit it holds no memory").toEqual([]);
  expect(await blocking[1], "during the save it does").toMatchObject([{ turnId, model: MODEL }]);
});

it("a load of the model a send waits on is said as loading only once the send has been answered", async () => {
  let heardBeforeAnswer: number | undefined;
  const r = rig({ reserved: () => {
    r.app.fitTable.load({ model: MODEL, numCtx: 16384, state: "loading" });
    heardBeforeAnswer = r.said.filter((s) => s.threadId === r.thread.id).length;
  } });
  const { turnId } = await sent(r, "hi");
  expect(heardBeforeAnswer, "nothing of the turn is said before its answer").toBe(0);
  await until(() => r.events(turnId).some((e) => e.type === "reply"), "the loading record");
  expect(r.events(turnId).find((e) => e.type === "reply")).toMatchObject({ reply: { stage: "loading" } });
});

it("a send still waiting to be admitted counts as an active turn before anything streams", async () => {
  const r = rig();
  const { turnId } = await sent(r, "hi");
  await settle();
  expect(r.events(turnId).filter((e) => e.type !== "reply")).toEqual([]);
  expect(r.app.activeTurns()).toBe(1);
  r.open();
  await until(() => r.app.activeTurns() === 0, "the turn to end");
});
