import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Channel, Reply, ReplyChange, ShellStatus } from "@gates-local/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createApp, type AppDeps } from "../app.ts";
import { sendStarted } from "../chat/send-started.ts";
import { defaultSettings } from "../settings/store.ts";
import { createSources } from "../sources/index.ts";
import { openThreadStore } from "../threads/store.ts";
import type { TurnEvent, TurnSaid } from "./turn.ts";
import { MODEL, until } from "../../test/send-rig.ts";

const OTHER = "gemma3:12b";
const SHOW = JSON.parse(readFileSync(new URL("../fit/fixtures/show-qwen3-5-9b.json", import.meta.url), "utf8")) as Record<string, unknown>;
const READY = { state: "ready", owner: "external", baseUrl: "http://fake" } as const;
const RETRIED = "running it once more";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).toReversed()) await clean();
  vi.unstubAllGlobals();
});

const installed = (name: string) => ({ name, digest: name, sizeBytes: 6_600_000_000, modifiedAt: "2026-11-01T00:00:00Z", capabilities: ["completion" as const] });
const catalog = {
  current: () => [installed(MODEL), installed(OTHER)],
  refresh: async () => ({ models: [installed(MODEL), installed(OTHER)], changed: false }),
  onChange: () => () => {},
  stop: () => {},
};

const encoded = (rows: readonly unknown[]) => new TextEncoder().encode(rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
const ndjson = (rows: readonly unknown[]) => new Response(encoded(rows));
const answered = () => ndjson([{ model: MODEL, message: { role: "assistant", content: "ok" }, done: true, done_reason: "stop" }]);

/** Writes its first words and waits: a cut errors the stream, or with `fails`, the stream says an error of its own. */
function dripping(signal: AbortSignal | undefined, fails = false): Response {
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(encoded([{ model: MODEL, message: { role: "assistant", content: "some words" }, done: false }]));
    signal?.addEventListener("abort", () => {
      if (!fails) return controller.error(signal.reason);
      controller.enqueue(encoded([{ error: "the model runner crashed" }]));
      controller.close();
    }, { once: true });
  } }));
}

type ChatReply = (n: number, model: string, signal: AbortSignal | undefined) => Response;

interface RigOptions {
  readonly chat?: ChatReply;
  readonly show?: (started: boolean) => Response;
  readonly loader?: true;
  readonly deps?: Pick<AppDeps, "settings" | "toolsEnabled" | "shellStatus" | "sources">;
}

function rig(options: RigOptions = {}) {
  const root = path.join(os.homedir(), ".cache", "gates-local-tests");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "turn-ends-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = openThreadStore(path.join(dir, "threads.sqlite"));
  const thread = db.createThread({ title: "A" });
  const chats: { model: string; tools?: unknown }[] = [];
  const said: TurnSaid[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const where = new URL(String(url)).pathname;
    if (where === "/api/show") return options.show?.(said.some((s) => s.event.type === "start")) ?? Response.json(SHOW);
    if (where === "/api/ps") return Response.json({ models: [{ name: MODEL, model: MODEL, size: 6_600_000_000, size_vram: 6_600_000_000, context_length: 16384, expires_at: "later", digest: "d" }] });
    if (where === "/api/tags") return Response.json({ models: [MODEL, OTHER].map((name) => ({ name, size: 6_600_000_000, digest: name, modified_at: "2026-11-01T00:00:00Z" })) });
    if (where === "/api/chat") {
      const body = JSON.parse(String(init?.body)) as { model: string; tools?: unknown };
      chats.push(body);
      return (options.chat ?? answered)(chats.length, body.model, init?.signal ?? undefined);
    }
    throw new Error(`Unexpected request: ${where}`);
  });
  const switches: AbortController[] = [];
  const pushes: { channel: Channel; payload: unknown }[] = [];
  const logs: string[] = [];
  const app = createApp({
    store: db,
    dataDir: dir,
    runtime: { status: () => READY, baseUrl: () => "http://fake", onChange: () => () => {}, ensure: async () => READY, lookIfDown: async () => READY },
    catalog,
    push: (channel, payload) => { pushes.push({ channel, payload }); },
    turnSaid: (s) => { said.push(s); },
    log: (line) => { logs.push(line); },
    fit: { runNvidiaSmi: async (args) => (args[0]?.startsWith("--query-gpu") ? "16384, 1024, 15360\n" : ""), readMeminfo: async () => "MemAvailable: 32000000 kB\n" },
    ...options.deps,
    ...(options.loader ? { models: { handlers: {}, loader: { reserve: () => {
      const runtime = new AbortController();
      switches.push(runtime);
      return {
        baseUrl: "http://fake", signal: runtime.signal, cold: false, firstToken: () => {}, end: () => {},
        admit: async (_ctx, admitting) => {
          if (admitting?.fit === undefined) throw new Error("missing app fit");
          return admitting.fit(runtime.signal, { handoff: undefined, leave: async () => undefined });
        },
      };
    } } } } : {}),
  });
  cleanups.push(async () => { await app.shutdown(); db.close(); });
  const terminal = (turnId: string): TurnEvent[] => said.flatMap((s) => s.turnId === turnId && (s.event.type === "error" || s.event.type === "done") ? [s.event] : []);
  const ended = (turnId: string) => until(() => terminal(turnId).length > 0, "the turn's end");
  const latest = (id: string): Reply | undefined => {
    const told = pushes.flatMap((p) => p.channel === "reply.changed" ? [p.payload as ReplyChange] : []);
    const c = told.findLast((t) => (t.kind === "is" ? t.reply.id : t.id) === id);
    return c?.kind === "is" ? c.reply : undefined;
  };
  const words = (turnId: string) => said.some((s) => s.turnId === turnId && s.event.type === "delta");
  const send = (content = "hello", model = MODEL, more: { stopOthers?: true; threadId?: string; tools?: boolean } = {}) =>
    sendStarted(app, { threadId: thread.id, content, model, numCtx: 16384, ...more }, { clientId: 1 });
  return { app, db, dir, thread, chats, switches, logs, terminal, ended, latest, words, send, h: app.handlers as Required<typeof app.handlers> };
}

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
function pretendPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  cleanups.push(() => { if (realPlatform !== undefined) Object.defineProperty(process, "platform", realPlatform); });
}

async function switchMidReply() {
  const r = rig({ loader: true, chat: (_n, _model, signal) => dripping(signal) });
  const x = await r.send();
  await until(() => r.words(x.turnId), "the first words");
  for (const runtime of r.switches) runtime.abort(new Error("the runtime switched"));
  await r.ended(x.turnId);
  return { r, x };
}

it("a reply a runtime switch ends tells the person to send the message again", async () => {
  const { r, x } = await switchMidReply();
  expect(r.terminal(x.turnId)).toEqual([expect.objectContaining({ type: "error", code: "runtime-changed", message: expect.stringMatching(/send the message again/i) })]);
});

it("a reply a runtime switch ends is kept as stopped by the runtime", async () => {
  const { r, x } = await switchMidReply();
  await until(() => r.latest(x.id)?.stage === "stopped", "the record's end");
  expect(r.latest(x.id)).toMatchObject({ stage: "stopped", by: { who: "runtime" } });
});

it("a reply the app closes on is kept as stopped by the closing app", async () => {
  const r = rig({ chat: (_n, _model, signal) => dripping(signal) });
  const x = await r.send();
  await until(() => r.words(x.turnId), "the first words");
  await r.app.shutdown();
  await r.ended(x.turnId);
  expect(r.latest(x.id)).toMatchObject({ stage: "stopped", by: { who: "closing" } });
});

it("a reply another model's load pushes out of the GPU is kept as stopped by that model, which it names", async () => {
  const r = rig({ chat: (_n, model, signal) => (model === MODEL ? dripping(signal) : answered()) });
  const x = await r.send();
  await until(() => r.words(x.turnId), "the first words");
  const other = r.db.createThread({ title: "B" });
  await r.send("hi", OTHER, { stopOthers: true, threadId: other.id });
  await r.ended(x.turnId);
  expect(r.terminal(x.turnId)).toMatchObject([{ type: "error", code: "preempted" }]);
  expect(r.latest(x.id)).toMatchObject({ stage: "stopped", by: { who: "preempted", neededBy: OTHER } });
});

it("on Windows a turn with tools on and an empty Library is a plain turn: no shell is asked for or offered", async () => {
  const shellStatus = vi.fn(async (): Promise<ShellStatus> => ({ state: "ready" }));
  const r = rig({ deps: { toolsEnabled: () => true, shellStatus } });
  pretendPlatform("win32");
  const x = await r.send("run uname -a", MODEL, { tools: true });
  await r.ended(x.turnId);
  expect(r.terminal(x.turnId)).toMatchObject([{ type: "done" }]);
  expect(shellStatus).not.toHaveBeenCalled();
  expect(r.chats).toHaveLength(1);
  expect(r.chats[0]?.tools).toBeUndefined();
});

it("a turn whose installed prompt cannot be read ends as failed and sends no chat request", async () => {
  const r = rig({ deps: { settings: { get: () => defaultSettings("system") } }, show: (started) => (started ? new Response("show broke", { status: 500 }) : Response.json(SHOW)) });
  const x = await r.send();
  await r.ended(x.turnId);
  expect(r.terminal(x.turnId)).toMatchObject([{ type: "error", ended: { reason: "failed" } }]);
  expect(r.chats).toEqual([]);
});

it("an installed prompt too long for the context is refused, with no chat request", async () => {
  const r = rig({ deps: { settings: { get: () => defaultSettings("system") } }, show: (started) => Response.json(started ? { ...SHOW, system: "x".repeat(70000) } : SHOW) });
  const x = await r.send();
  await r.ended(x.turnId);
  expect(r.terminal(x.turnId)).toMatchObject([{ type: "error", code: "context-too-small", ended: { reason: "failed" } }]);
  expect(r.chats).toEqual([]);
});

it("deleting the question of a running reply ends it as stopped", async () => {
  const r = rig({ chat: (_n, _model, signal) => dripping(signal) });
  const x = await r.send();
  await until(() => r.words(x.turnId), "the first words");
  await r.h["messages.delete"]({ threadId: r.thread.id, messageId: x.userMessage.id }, { clientId: 1 });
  await r.ended(x.turnId);
  expect(r.terminal(x.turnId)).toMatchObject([{ type: "error", code: "cancelled", ended: { reason: "stopped" } }]);
});

it("a reply that fails on its own after a Stop ends as failed, not stopped", async () => {
  const r = rig({ chat: (_n, _model, signal) => dripping(signal, true) });
  const x = await r.send();
  await until(() => r.words(x.turnId), "the first words");
  r.h["reply.stop"]({ id: x.turnId }, { clientId: 1 });
  await r.ended(x.turnId);
  expect(r.terminal(x.turnId)).toMatchObject([{ type: "error", code: "stream-error", ended: { reason: "failed" } }]);
});

it("a reply for a model Ollama does not have fails once, with no second attempt", async () => {
  const r = rig({ chat: () => Response.json({ error: "model not found" }, { status: 404 }) });
  const x = await r.send();
  await r.ended(x.turnId);
  expect(r.terminal(x.turnId)).toMatchObject([{ type: "error", code: "model-not-found" }]);
  expect(r.chats).toHaveLength(1);
  expect(r.logs.filter((line) => line.includes(RETRIED))).toEqual([]);
});

it("a question too long for the context fails once, with no second attempt", async () => {
  const r = rig();
  const x = await r.send("x".repeat(70000));
  await r.ended(x.turnId);
  expect(r.terminal(x.turnId)).toMatchObject([{ type: "error", code: "context-too-small" }]);
  expect(r.logs.filter((line) => line.includes(RETRIED))).toEqual([]);
});

it("a reply that fails after a Stop is not run again, and keeps the words it had", async () => {
  const r = rig({ chat: (_n, _model, signal) => dripping(signal, true) });
  const x = await r.send();
  await until(() => r.words(x.turnId), "the first words");
  r.h["reply.stop"]({ id: x.turnId }, { clientId: 1 });
  await r.ended(x.turnId);
  expect(r.logs.filter((line) => line.includes(RETRIED))).toEqual([]);
  expect(r.terminal(x.turnId)).toMatchObject([{ type: "error", partial: { content: "some words", interrupted: true } }]);
  expect(r.chats).toHaveLength(1);
});

it("a reply that fails after its question was deleted is not run again", async () => {
  const r = rig({ chat: (_n, _model, signal) => dripping(signal, true) });
  const x = await r.send();
  await until(() => r.words(x.turnId), "the first words");
  await r.h["messages.delete"]({ threadId: r.thread.id, messageId: x.userMessage.id }, { clientId: 1 });
  await r.ended(x.turnId);
  expect(r.logs.filter((line) => line.includes(RETRIED))).toEqual([]);
  expect(r.chats).toHaveLength(1);
  expect(r.db.getThread(r.thread.id).messages).toEqual([]);
});

it("a reply that fails after one of its tool calls ran is not run again, so the call does not run twice", async () => {
  mkdirSync(path.join(os.homedir(), ".cache", "gates-local-tests"), { recursive: true });
  const root = mkdtempSync(path.join(os.homedir(), ".cache", "gates-local-tests", "turn-ends-library-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const sources = createSources({ dataDir: path.join(root, "data") });
  const note = path.join(root, "notes.txt");
  writeFileSync(note, "hello library");
  const source = await sources.add({ kind: "file", path: note });
  const r = rig({
    deps: { sources, toolsEnabled: () => true },
    chat: (n) => (n === 1
      ? ndjson([{ model: MODEL, message: { role: "assistant", content: "", tool_calls: [{ function: { name: "read", arguments: { path: `/library/${source.id}` } } }] }, done: true }])
      : new Response("the runtime hiccuped", { status: 500 })),
  });
  const x = await r.send("read my notes", MODEL, { tools: true });
  await r.ended(x.turnId);
  expect(r.terminal(x.turnId)).toMatchObject([{ type: "error", partial: { tools: [{ name: "read", state: "done" }] } }]);
  expect(r.chats).toHaveLength(2);
  expect(r.logs.filter((line) => line.includes(RETRIED))).toEqual([]);
});
