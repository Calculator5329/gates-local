import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createApp, type App, type AppDeps } from "../app.ts";
import * as lifecycles from "../chat/image-lifecycle.ts";
import { sendStarted } from "../chat/send-started.ts";
import { testPng } from "../pictures/test-png.ts";
import { createSources } from "../sources/index.ts";
import { openThreadStore } from "../threads/store.ts";
import { chatCatalog, rig as sendRig, settle, until } from "../../test/send-rig.ts";
import type { TurnSaid } from "./turn.ts";

const MODEL = "qwen3.5:9b";
const SHOW: unknown = JSON.parse(readFileSync(new URL("../fit/fixtures/show-qwen3-5-9b.json", import.meta.url), "utf8"));
const READY = { state: "ready", owner: "external", baseUrl: "http://fake" } as const;
const RUNTIME: AppDeps["runtime"] = { status: () => READY, baseUrl: () => "http://fake", onChange: () => () => {}, ensure: async () => READY, lookIfDown: async () => READY };
const FIT: AppDeps["fit"] = { runNvidiaSmi: async (args) => (args[0]?.startsWith("--query-gpu") ? "16384, 1024, 15360\n" : ""), readMeminfo: async () => "MemAvailable: 32000000 kB\n" };
const encoder = new TextEncoder();
const line = (content: string, done: boolean) => encoder.encode(`${JSON.stringify({ model: MODEL, message: { role: "assistant", content }, done, ...(done ? { done_reason: "stop" } : {}) })}\n`);

interface ChatBody {
  readonly think?: boolean;
  readonly tools?: readonly { readonly function: { readonly name: string } }[];
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const clean of cleanups.splice(0).toReversed()) await clean();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function tmp(): string {
  const root = path.join(os.homedir(), ".cache", "gates-local-tests");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "app-deps-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
async function soon(ok: () => boolean, what: string) {
  for (let i = 0; i < 2000 && !ok(); i++) await nextTurn();
  if (!ok()) throw new Error(`timed out waiting for ${what}`);
}

interface RigOptions {
  readonly deps?: Partial<AppDeps>;
  readonly held?: true;
  readonly onSaid?: (said: TurnSaid, app: App) => void;
}

function rig(options: RigOptions = {}) {
  const dir = tmp();
  const store = openThreadStore(path.join(dir, "threads.sqlite"));
  const thread = store.createThread({ title: "A" });
  const chats: ChatBody[] = [];
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const where = new URL(String(url)).pathname;
    if (where === "/api/show") return Response.json(SHOW);
    if (where === "/api/ps") return Response.json({ models: [] });
    if (where === "/api/tags") return Response.json({ models: [{ name: MODEL, size: 6600000000, digest: "d", modified_at: "2026-11-01T00:00:00Z" }] });
    if (where !== "/api/chat") throw new Error(`Unexpected request: ${where}`);
    chats.push(JSON.parse(String(init?.body)) as ChatBody);
    if (options.held !== true) return new Response(line("ok", true));
    const stop = init?.signal;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      streams.push(controller);
      stop?.addEventListener("abort", () => controller.error(stop.reason), { once: true });
    } }));
  });
  const said: TurnSaid[] = [];
  const app: App = createApp({
    store, dataDir: dir, runtime: RUNTIME, catalog: chatCatalog(), push: () => {}, fit: FIT,
    turnSaid: (s) => { said.push(s); options.onSaid?.(s, app); },
    ...options.deps,
  });
  cleanups.push(async () => { await app.shutdown(); store.close(); });
  const draft = () => store.getThread(thread.id).messages.find((m) => m.role === "assistant")?.content;
  const ended = (turnId: string) => said.some((s) => s.turnId === turnId && (s.event.type === "done" || s.event.type === "error"));
  return { app, store, thread, chats, streams, said, draft, ended, dir };
}

it("the app's think setting rides on a turn that asks for nothing itself", async () => {
  const r = rig({ deps: { think: true } });
  const sent = await sendStarted(r.app, { threadId: r.thread.id, content: "hi", model: MODEL, numCtx: 16384 });
  await until(() => r.ended(sent.turnId), "the reply's end");
  expect(r.chats).toHaveLength(1);
  expect(r.chats[0]).toMatchObject({ think: true });
});

it("with no think setting and none asked, the chat request carries no think flag at all", async () => {
  const r = rig();
  const sent = await sendStarted(r.app, { threadId: r.thread.id, content: "hi", model: MODEL, numCtx: 16384 });
  await until(() => r.ended(sent.turnId), "the reply's end");
  expect(r.chats).toHaveLength(1);
  expect(r.chats[0]).not.toHaveProperty("think");
});

it.skipIf(process.platform === "win32")("with no sandbox check given, a tool turn still offers the model the shell", async () => {
  const dir = tmp();
  const own = path.join(dir, "notes.txt");
  writeFileSync(own, "a note");
  const sources = createSources({ dataDir: path.join(dir, "library") });
  await sources.add({ kind: "file", path: own });
  const r = rig({ deps: { sources, toolsEnabled: () => true } });
  const sent = await sendStarted(r.app, { threadId: r.thread.id, content: "what is in my notes?", model: MODEL, numCtx: 16384 });
  await until(() => r.ended(sent.turnId), "the reply's end");
  expect(r.chats[0]?.tools?.map((t) => t.function.name)).toContain("shell");
});

it("a streaming reply on disk is rewritten a second after its last write, not sooner", async () => {
  const r = rig({ held: true });
  const sent = await sendStarted(r.app, { threadId: r.thread.id, content: "hi", model: MODEL, numCtx: 16384 });
  await until(() => r.streams.length === 1, "the chat request");
  const stream = r.streams[0]!;
  stream.enqueue(line("one ", false));
  await until(() => r.draft() === "one ", "the first words on disk");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  stream.enqueue(line("two ", false));
  await soon(() => r.said.some((s) => s.event.type === "delta" && s.event.text === "two "), "the second words");
  vi.advanceTimersByTime(999);
  expect(r.draft()).toBe("one ");
  vi.advanceTimersByTime(1);
  expect(r.draft()).toBe("one two ");
  vi.useRealTimers();
  stream.enqueue(line("", true));
  stream.close();
  await until(() => r.ended(sent.turnId), "the reply's end");
});

it("a message's work reads as started while its reply streams, and as gone from the moment the reply ends", async () => {
  const atEnd: unknown[] = [];
  const r = rig({ held: true, onSaid: (s, app) => { if (s.event.type === "done") atEnd.push(app.started("q1")); } });
  const sent = await sendStarted(r.app, { id: "q1", threadId: r.thread.id, content: "hi", model: MODEL, numCtx: 16384 });
  await until(() => r.streams.length === 1, "the chat request");
  r.streams[0]!.enqueue(line("one ", false));
  await until(() => r.draft() === "one ", "the first words");
  expect(r.app.started("q1")?.turnId).toBe(sent.turnId);
  r.streams[0]!.enqueue(line("", true));
  r.streams[0]!.close();
  await until(() => r.ended(sent.turnId), "the reply's end");
  expect(atEnd).toEqual([undefined]);
  await sent.ended;
  expect(r.app.started("q1")).toBeUndefined();
});

it("a second shutdown while the first still waits also waits for the active turn to end, and a later one returns at once", async () => {
  const r = sendRig();
  await r.h["reply.send"](r.entry("a", "hi"), { clientId: 1 });
  expect(r.app.activeTurns()).toBe(1);
  await settle();
  const first = r.app.shutdown();
  const second = r.app.shutdown();
  let secondDone = false;
  void second.then(() => { secondDone = true; });
  await settle();
  expect(secondDone).toBe(false);
  expect(r.app.activeTurns()).toBe(1);
  r.open();
  await Promise.all([first, second]);
  expect(r.app.activeTurns()).toBe(0);
  await expect(r.app.shutdown()).resolves.toBeUndefined();
});

it("a missing thumbnail is made only when the image files' earlier work is done", async () => {
  const real = lifecycles.imageLifecycle;
  let files: ReturnType<typeof real> | undefined;
  vi.spyOn(lifecycles, "imageLifecycle").mockImplementation((...args) => (files = real(...args)));
  const r = rig();
  const job = randomUUID();
  mkdirSync(path.join(r.dir, "images"), { recursive: true });
  writeFileSync(path.join(r.dir, "images", `${job}.png`), testPng(64, 32));
  const gate: { open?: () => void } = {};
  const earlier = files!.queue(() => new Promise<void>((resolve) => { gate.open = resolve; }));
  const thumb = r.app.thumbnail(job);
  let made = false;
  void thumb.then(() => { made = true; });
  await settle();
  expect(made).toBe(false);
  expect(existsSync(path.join(r.dir, "images", "thumbs", `${job}.webp`))).toBe(false);
  gate.open!();
  await earlier;
  expect((await thumb)?.toString("latin1", 8, 12)).toBe("WEBP");
  expect(existsSync(path.join(r.dir, "images", "thumbs", `${job}.webp`))).toBe(true);
});
