import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHAT_MODELS, type Channel, type FitTable, type Reply } from "@gates-local/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import * as imageFiles from "../chat/image-lifecycle.ts";
import { sendTaken } from "../chat/send-started.ts";
import { useChatList } from "../runtime/chat-list.ts";
import { openThreadStore } from "../threads/store.ts";
import type { TurnEvent, TurnSaid } from "./turn.ts";
import { MODEL, settle, until } from "../../test/send-rig.ts";

const OTHER = "gemma3:4b";
const NEWCOMER = "newcomer:7b";
const ROOT = path.join(os.homedir(), ".cache", "gates-local-tests");
const SHOW: unknown = JSON.parse(readFileSync(new URL("../fit/fixtures/show-qwen3-5-9b.json", import.meta.url), "utf8"));
const READY = { state: "ready", owner: "external", baseUrl: "http://fake" } as const;
const ctx = { clientId: 1 };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).toReversed()) await clean();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const noop = (): void => {};

const installed = (name: string) => ({ name, digest: name, sizeBytes: 6_600_000_000, modifiedAt: "2026-11-01T00:00:00Z", capabilities: ["completion" as const] });

const encoded = (rows: readonly unknown[]) => new TextEncoder().encode(rows.map((row) => `${JSON.stringify(row)}\n`).join(""));

const answer = () => new Response(encoded([{ model: MODEL, message: { role: "assistant", content: "ok" }, done: true, done_reason: "stop" }]));

function dripping(signal: AbortSignal | null | undefined): Response {
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(encoded([{ model: MODEL, message: { role: "assistant", content: "some words" }, done: false }]));
    signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
  } }));
}

function rig(options: { readonly drip?: true } = {}) {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(path.join(ROOT, "app-wiring-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = openThreadStore(path.join(dir, "threads.sqlite"));
  const thread = db.createThread({ title: "A" });
  const chatSignals: AbortSignal[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const where = new URL(String(input)).pathname;
    if (where === "/api/show") return Response.json(SHOW);
    if (where === "/api/ps") return Response.json({ models: [] });
    if (where === "/api/tags") return Response.json({ models: [MODEL, OTHER].map((name) => ({ name, size: 6_600_000_000, digest: name, modified_at: "2026-11-01T00:00:00Z" })) });
    if (where === "/api/chat") {
      if (init?.signal) chatSignals.push(init.signal);
      return options.drip === true ? dripping(init?.signal) : answer();
    }
    throw new Error(`Unexpected request: ${where}`);
  });
  let open = noop;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const admits: string[] = [];
  const reservations: { model: string; controller: AbortController }[] = [];
  const pushes: { channel: Channel; payload: unknown }[] = [];
  const said: TurnSaid[] = [];
  const logs: string[] = [];
  const models = [installed(MODEL), installed(OTHER)];
  const app = createApp({
    store: db,
    dataDir: dir,
    log: (line) => { logs.push(line); },
    runtime: { status: () => READY, baseUrl: () => READY.baseUrl, onChange: () => noop, ensure: async () => READY, lookIfDown: async () => READY },
    catalog: { current: () => models, refresh: async () => ({ models, changed: false }), onChange: () => noop, stop: noop },
    push: (channel, payload) => { pushes.push({ channel, payload }); },
    turnSaid: (s) => { said.push(s); },
    fit: { runNvidiaSmi: async (args) => (args[0]?.startsWith("--query-gpu") ? "16303, 1303, 15000\n" : ""), readMeminfo: async () => "MemTotal: 32000000 kB\nMemAvailable: 32000000 kB\n" },
    models: { handlers: {}, loader: { reserve: (model: string) => {
      const controller = new AbortController();
      reservations.push({ model, controller });
      return {
        baseUrl: READY.baseUrl, signal: controller.signal, cold: false, firstToken: noop, end: noop,
        admit: async (_numCtx, admitOptions) => {
          admits.push(model);
          await gate;
          if (admitOptions?.fit === undefined) throw new Error("missing app fit");
          return admitOptions.fit(admitOptions.signal ?? controller.signal, { handoff: undefined, leave: async () => undefined });
        },
      };
    } } },
  });
  cleanups.push(async () => { open(); await app.shutdown(); db.close(); });
  const h = app.handlers as Required<typeof app.handlers>;
  const events = (turnId: string): TurnEvent[] => said.flatMap((s) => (s.turnId === turnId ? [s.event] : []));
  const terminal = (turnId: string) => events(turnId).filter((e) => e.type === "error" || e.type === "done");
  const listed = async (id: string): Promise<Reply | undefined> => (await h["reply.list"]({}, ctx)).find((l) => l.reply.id === id)?.reply;
  const saidLoading = (turnId: string) => events(turnId).some((e) => e.type === "reply" && e.reply.stage === "loading");
  const runtimeSwitch = (model: string) => {
    const reservation = reservations.find((s) => s.model === model);
    if (reservation === undefined) throw new Error(`${model} reserved nothing`);
    reservation.controller.abort();
  };
  return { app, db, thread, h, open, admits, pushes, logs, chatSignals, events, terminal, listed, saidLoading, runtimeSwitch };
}

const fitPushes = (pushes: readonly { channel: Channel; payload: unknown }[]): FitTable[] =>
  pushes.flatMap((p) => (p.channel === "fit.changed" ? [p.payload as FitTable] : []));

it("a send after the start-up image sweep failed is still answered and its reply streams and is saved", async () => {
  const lifecycle = imageFiles.imageLifecycle;
  const sweep = vi.fn().mockRejectedValue(new Error("EACCES: image folder denied"));
  vi.spyOn(imageFiles, "imageLifecycle").mockImplementation((...args) => ({ ...lifecycle(...args), sweep }));
  const r = rig();
  expect(sweep).toHaveBeenCalledTimes(1);
  const sent = await sendTaken(r.app, { threadId: r.thread.id, content: "hi", model: MODEL, numCtx: 16384 }, ctx);
  r.open();
  await sent.admission;
  await until(() => r.terminal(sent.turnId).length > 0, "the reply's end");
  expect(r.terminal(sent.turnId)).toMatchObject([{ type: "done" }]);
  expect(r.events(sent.turnId).map((e) => e.type)).toContain("start");
  expect(r.db.getThread(r.thread.id).messages.map((m) => [m.role, m.content])).toEqual([["user", "hi"], ["assistant", "ok"]]);
  expect(r.logs.filter((l) => /image sweep at start-up failed.*EACCES/.test(l))).toHaveLength(1);
});

it.each(["ready", "unloaded"] as const)("a model whose load has ended (%s) no longer makes a later start that waits on it say loading", async (state) => {
  const r = rig();
  r.app.fitTable.load({ model: MODEL, numCtx: 16384, state: "loading" });
  r.app.fitTable.load({ model: MODEL, numCtx: 16384, state });
  const sent = await sendTaken(r.app, { threadId: r.thread.id, content: "hi", model: MODEL, numCtx: 16384 }, ctx);
  sent.admission.catch(noop);
  await until(() => r.admits.includes(MODEL), "the start to wait at its admission");
  await settle();
  expect(await r.listed(sent.id)).toMatchObject({ stage: "starting" });
  expect(await r.listed(sent.id)).not.toMatchObject({ loading: true });
  expect(r.saidLoading(sent.turnId), "the start says waiting").toBe(false);
  r.app.fitTable.load({ model: MODEL, numCtx: 16384, state: "loading" });
  await until(() => r.saidLoading(sent.turnId), "a new load of its model to say loading");
});

it("a start waiting while a different model loads says waiting, not loading", async () => {
  const r = rig();
  r.app.fitTable.load({ model: OTHER, numCtx: 16384, state: "loading" });
  const sent = await sendTaken(r.app, { threadId: r.thread.id, content: "hi", model: MODEL, numCtx: 16384 }, ctx);
  sent.admission.catch(noop);
  await until(() => r.admits.includes(MODEL), "the start to wait at its admission");
  await settle();
  expect(await r.listed(sent.id)).not.toMatchObject({ loading: true });
  expect(r.saidLoading(sent.turnId), "another model's load leaves it waiting").toBe(false);
  r.app.fitTable.load({ model: MODEL, numCtx: 16384, state: "loading" });
  await until(() => r.saidLoading(sent.turnId), "its own model's load to say loading");
});

it("a newer chat model list gives a model only that list names its rows in the fit table", async () => {
  const r = rig();
  cleanups.push(() => useChatList(CHAT_MODELS));
  const before = await r.h["fit.table"]({}, ctx);
  expect(before.rows.length).toBeGreaterThan(0);
  expect(before.rows.some((row) => row.model === NEWCOMER)).toBe(false);
  useChatList({
    ...CHAT_MODELS,
    revision: CHAT_MODELS.revision + 1,
    models: [...CHAT_MODELS.models, { name: NEWCOMER, label: "Newcomer", purpose: "Test model", downloadBytes: 4_000_000_000 }],
  });
  await until(() => fitPushes(r.pushes).some((t) => t.rows.some((row) => row.model === NEWCOMER)), "a table with the new model's rows");
  const table = fitPushes(r.pushes).findLast((t) => t.rows.some((row) => row.model === NEWCOMER));
  expect(table?.rows.filter((row) => row.model === NEWCOMER).length).toBeGreaterThan(0);
  expect(r.pushes.some((p) => p.channel === "models.suggested")).toBe(true);
});

it("a runtime switch after a Stop ends the reply as the switch's, while its request keeps the Stop's reason", async () => {
  const r = rig({ drip: true });
  const sent = await sendTaken(r.app, { threadId: r.thread.id, content: "hi", model: MODEL, numCtx: 16384 }, ctx);
  sent.admission.catch(noop);
  r.open();
  await until(() => r.events(sent.turnId).some((e) => e.type === "delta"), "the first words");
  expect(r.h["reply.stop"]({ id: sent.turnId }, ctx)).toMatchObject({ answer: "done" });
  r.runtimeSwitch(MODEL);
  await until(() => r.terminal(sent.turnId).length > 0, "the reply's end");
  expect(r.terminal(sent.turnId)).toMatchObject([{ type: "error", code: "runtime-changed", ended: { reason: "preempted" } }]);
  expect(r.chatSignals).toHaveLength(1);
  expect(r.chatSignals[0]?.aborted).toBe(true);
  expect(r.chatSignals[0]?.reason).not.toMatchObject({ code: "runtime-changed" });
});

it.each([
  ["a runtime switch", (r: ReturnType<typeof rig>) => { r.runtimeSwitch(MODEL); }],
  ["the app closing", (r: ReturnType<typeof rig>) => { void r.app.shutdown(); }],
] as const)("a start cut by %s before it is saved is back on hold at once, refused, and nothing of it is saved", async (_cut, cut) => {
  const r = rig();
  const sent = await sendTaken(r.app, { threadId: r.thread.id, content: "hi", model: MODEL, numCtx: 16384 }, ctx);
  sent.admission.catch(noop);
  await until(() => r.admits.includes(MODEL), "the start to wait at its admission");
  expect(await r.listed(sent.id)).toMatchObject({ stage: "starting" });
  cut(r);
  expect(await r.listed(sent.id)).toMatchObject({ stage: "held", held: { why: "refused" } });
  r.open();
  await sent.ended;
  expect(r.events(sent.turnId).map((e) => e.type)).not.toContain("start");
  expect(r.db.getThread(r.thread.id).messages).toEqual([]);
});
