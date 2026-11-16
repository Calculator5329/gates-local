import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Channel, Message, ReplyChange, ToolStep } from "@gates-local/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import type { TurnEvent, TurnSaid } from "./turn.ts";
import type { ImageModule } from "../image/module.ts";
import * as tools from "../chat/tools.ts";
import { sendStarted } from "../chat/send-started.ts";
import { openThreadStore } from "../threads/store.ts";
import { chatCatalog } from "../../test/send-rig.ts";

vi.mock("../chat/tools.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../chat/tools.ts")>();
  return { ...real, streamToolTurn: vi.fn(real.streamToolTurn) };
});

const MODEL = "qwen3.5:9b";
const SHOW: unknown = JSON.parse(readFileSync(new URL("../fit/fixtures/show-qwen3-5-9b.json", import.meta.url), "utf8"));
const READY = { state: "ready", owner: "external", baseUrl: "http://fake" } as const;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).toReversed()) await clean();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type Heard = { readonly said: TurnSaid } | { readonly channel: Channel; readonly payload: unknown };
type Chat = (n: number, signal: AbortSignal | undefined) => Response | Promise<Response>;
type WordsPayload = { readonly id: string; readonly part: { readonly type: string; readonly from?: number; readonly text?: string } };

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const piece = (content: string) => line({ model: MODEL, message: { role: "assistant", content }, done: false });
const thought = (thinking: string) => line({ model: MODEL, message: { role: "assistant", content: "", thinking }, done: false });
const DONE = line({ model: MODEL, message: { role: "assistant", content: "" }, done: true, done_reason: "stop" });
const failing = (error: string) => line({ error });
const toolCall = (name: string, args: Record<string, unknown>) => line({ model: MODEL, message: { role: "assistant", content: "", tool_calls: [{ function: { name, arguments: args } }] }, done: true, done_reason: "stop" });
const body = (...lines: string[]) => new Response(lines.join(""));

const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!ok()) throw new Error(`timed out waiting for ${what}`);
};

const noop = (): void => {};

function gate(): { promise: Promise<void>; open: () => void } {
  let open = noop;
  const promise = new Promise<void>((done) => { open = done; });
  return { promise, open };
}

const saidOf = (h: Heard): TurnSaid | undefined => ("said" in h ? h.said : undefined);
const changeOf = (h: Heard): ReplyChange | undefined => ("channel" in h && h.channel === "reply.changed" ? (h.payload as ReplyChange) : undefined);
const wordsOf = (h: Heard): WordsPayload | undefined => ("channel" in h && h.channel === "reply.words" ? (h.payload as WordsPayload) : undefined);
const changedId = (c: ReplyChange) => (c.kind === "is" ? c.reply.id : c.id);

interface RigOptions {
  readonly chat: Chat;
  readonly tools?: { readonly generate: () => Promise<{ jobId: string }> };
  readonly onSaid?: (said: TurnSaid) => void;
  readonly onPush?: (channel: Channel, payload: unknown) => void;
}

function rig({ chat, tools: toolRig, onSaid, onPush }: RigOptions) {
  const root = path.join(os.homedir(), ".cache", "gates-local-tests");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "run-turn-events-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = openThreadStore(path.join(dir, "threads.sqlite"));
  const thread = db.createThread({ title: "A" });
  let chats = 0;
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const where = new URL(String(url)).pathname;
    if (where === "/api/show") return Response.json(toolRig === undefined ? SHOW : { ...(SHOW as object), capabilities: ["completion", "tools"] });
    if (where === "/api/ps") return Response.json({ models: [] });
    if (where === "/api/tags") return Response.json({ models: [{ name: MODEL, size: 6600000000, digest: "d", modified_at: "2026-11-01T00:00:00Z" }] });
    if (where === "/api/chat") return chat(++chats, init?.signal ?? undefined);
    throw new Error(`Unexpected request: ${where}`);
  });
  const signal = new AbortController().signal;
  const heard: Heard[] = [];
  const logged: string[] = [];
  const firstTokens: number[] = [];
  const image = toolRig === undefined ? undefined : {
    current: () => ({ state: "stopped", owner: "none" }),
    generate: toolRig.generate,
    cancel: () => ({ cancelled: true }),
    wait: async () => undefined,
  } as unknown as ImageModule;
  const app = createApp({
    store: db,
    dataDir: dir,
    runtime: { status: () => READY, baseUrl: () => "http://fake", onChange: () => () => {}, ensure: async () => READY, lookIfDown: async () => READY },
    catalog: chatCatalog(),
    push: (channel, payload) => { heard.push({ channel, payload }); onPush?.(channel, payload); },
    turnSaid: (s) => { heard.push({ said: s }); onSaid?.(s); },
    log: (text) => { logged.push(text); },
    fit: { runNvidiaSmi: async (args) => (args[0]?.startsWith("--query-gpu") ? "16384, 1024, 15360\n" : ""), readMeminfo: async () => "MemAvailable: 32000000 kB\n" },
    ...(image === undefined ? {} : { image, toolsEnabled: () => true, imageTool: () => ({ preset: "flux2-klein-4b-pixel", width: 768, height: 768 }) }),
    models: { handlers: {}, loader: { reserve: () => ({
      baseUrl: "http://fake", signal, cold: false, firstToken: () => { firstTokens.push(heard.length); }, end: () => {},
      admit: async (_ctx, options) => {
        if (options?.fit === undefined) throw new Error("missing app fit");
        return options.fit(signal, { handoff: undefined, leave: async () => undefined });
      },
    }) } },
  });
  cleanups.push(async () => { await app.shutdown(); db.close(); });
  const events = (turnId: string): TurnEvent[] => heard.flatMap((h) => { const s = saidOf(h); return s?.turnId === turnId ? [s.event] : []; });
  const terminal = (turnId: string) => events(turnId).find((e) => e.type === "done" || e.type === "error");
  const ended = (turnId: string) => until(() => terminal(turnId) !== undefined && app.activeTurns() === 0, "the turn to end");
  const send = (content: string) => sendStarted(app, { threadId: thread.id, content, model: MODEL, numCtx: 16384 }, { clientId: 1 });
  const rows = (): readonly Message[] => db.getThread(thread.id).messages;
  return { app, db, thread, heard, logged, firstTokens, events, terminal, ended, send, rows };
}

const running = (step: ToolStep) => step.state === "running";

it("a tool call is not the model's first word: the first-word mark and the send's timing line wait for text", async () => {
  vi.stubEnv("GATES_LOCAL_SEND_TIMES", "1");
  const atTool: { marks: number; lines: number }[] = [];
  const r = rig({
    tools: { generate: async () => ({ jobId: "job" }) },
    chat: (n) => (n === 1 ? body(toolCall("read", { path: "/library/nothing" })) : body(piece("found nothing"), DONE)),
    onSaid: (s) => {
      if (s.event.type === "tool") atTool.push({ marks: r.firstTokens.length, lines: r.logged.filter((l) => l.includes("first token")).length });
    },
  });
  const { turnId } = await r.send("look it up");
  await r.ended(turnId);
  expect(r.terminal(turnId)).toMatchObject({ type: "done", message: { content: "found nothing" } });
  expect(atTool.length, "the call was said before any text").toBeGreaterThan(0);
  expect(atTool.every((at) => at.marks === 0 && at.lines === 0)).toBe(true);
  expect(r.firstTokens.length, "the first text marks the first word").toBeGreaterThan(0);
  expect(r.logged.filter((l) => l.startsWith(`send ${turnId} first token`))).toHaveLength(1);
});

it("each stream event moves the reply's times to the stage its record shows: thinking while it thinks, writing once words come", async () => {
  const r = rig({ chat: () => body(thought("a plan"), piece("the answer"), DONE) });
  const { turnId } = await r.send("think first");
  await r.ended(turnId);
  const stages = r.events(turnId).flatMap((e) => (e.type === "reply" ? [e.reply.stage] : []));
  expect(stages).toContain("thinking");
  expect(stages.indexOf("thinking")).toBeLessThan(stages.indexOf("writing"));
});

it("a window gets a reply's new words before the record that names the stage they put it in", async () => {
  const r = rig({ chat: () => body(piece("some words"), DONE) });
  const { id, turnId } = await r.send("say something");
  await r.ended(turnId);
  const words = r.heard.findIndex((h) => { const w = wordsOf(h); return w?.id === id && w.part.type === "text"; });
  const record = r.heard.findIndex((h) => { const s = saidOf(h); return s?.turnId === turnId && s.event.type === "reply" && s.event.reply.stage === "writing"; });
  const told = r.heard.findIndex((h) => { const c = changeOf(h); return c !== undefined && c.kind === "is" && changedId(c) === id && c.reply.stage === "writing"; });
  expect(words).toBeGreaterThan(-1);
  expect(record).toBeGreaterThan(words);
  if (told !== -1) expect(told).toBeGreaterThan(words);
});

it("the app closing while a tool call runs saves the call as stopped, not as failed", async () => {
  const release = gate();
  const r = rig({
    tools: { generate: async () => { await release.promise; return { jobId: "job" }; } },
    chat: () => body(toolCall("image", { prompt: "a cat" })),
  });
  cleanups.push(release.open);
  const { turnId } = await r.send("draw a cat");
  await until(() => r.events(turnId).some((e) => e.type === "tool" && running(e.step)), "the call to run");
  await r.app.shutdown();
  expect(r.terminal(turnId)).toMatchObject({ type: "error", ended: { reason: "preempted" } });
  const saved = r.rows().at(-1);
  expect(saved).toMatchObject({ role: "assistant", interrupted: true, tools: [{ name: "image", state: "error", stopped: true }] });
});

it("a reply that fails on its own while a tool call runs saves the call as failed, with no stopped mark", async () => {
  const step: ToolStep = { callId: "call-1", name: "read", state: "running", summary: "Reading" };
  vi.mocked(tools.streamToolTurn).mockImplementationOnce(async function* broken() {
    yield { type: "tool", step };
    yield { type: "error", code: "stream-error", message: "model runner crashed" };
  });
  const r = rig({ tools: { generate: async () => ({ jobId: "job" }) }, chat: () => body(DONE) });
  const { turnId } = await r.send("read it");
  await r.ended(turnId);
  expect(r.terminal(turnId)).toMatchObject({ type: "error", code: "stream-error", ended: { reason: "failed" } });
  const saved = r.rows().at(-1);
  expect(saved).toMatchObject({ role: "assistant", interrupted: true, tools: [{ callId: "call-1", state: "error" }] });
  expect(saved?.tools?.[0]).not.toHaveProperty("stopped");
});

it("a step the app's closing dropped still runs the reply stream's own cleanup, once that step settles", async () => {
  const step: ToolStep = { callId: "call-1", name: "read", state: "running", summary: "Reading" };
  const hang = gate();
  let cleaned = false;
  vi.mocked(tools.streamToolTurn).mockImplementationOnce(async function* stuck() {
    try {
      yield { type: "tool", step };
      await hang.promise;
      yield { type: "tool", step: { ...step, state: "done" } };
    } finally {
      cleaned = true;
    }
  });
  const r = rig({ tools: { generate: async () => ({ jobId: "job" }) }, chat: () => body(DONE) });
  const { turnId } = await r.send("read it");
  await until(() => r.events(turnId).some((e) => e.type === "tool"), "the running call");
  await r.app.shutdown();
  expect(r.terminal(turnId)).toMatchObject({ ended: { reason: "preempted" } });
  expect(cleaned, "the dropped step has not settled yet").toBe(false);
  hang.open();
  await until(() => cleaned, "the stream's cleanup once the dropped step settles");
});

it("deleting the whole chat as the reply's last word lands ends it as stopped, never as done", async () => {
  let deleting: Promise<unknown> | undefined;
  const r = rig({
    chat: () => body(piece("all of it") + DONE),
    onSaid: (s) => {
      if (s.event.type !== "delta" || deleting !== undefined) return;
      deleting = Promise.resolve(r.app.handlers["threads.delete"]({ threadId: s.threadId }, { clientId: 1 }));
    },
  });
  const { turnId } = await r.send("count");
  await r.ended(turnId);
  await deleting;
  expect(r.events(turnId).some((e) => e.type === "done")).toBe(false);
  expect(r.terminal(turnId)).toMatchObject({ type: "error", code: "cancelled", ended: { reason: "stopped" } });
  expect(r.terminal(turnId)).toMatchObject({ message: "cancelled: its question was deleted" });
  expect(r.terminal(turnId)).not.toHaveProperty("partial");
  expect(() => r.db.getThread(r.thread.id)).toThrow();
});

it("the windows hear what became of a message waiting behind a reply only after that reply's last event", async () => {
  const answer = gate();
  const r = rig({
    chat: async (n) => {
      if (n > 1) return body(piece("ok"), DONE);
      await answer.promise;
      return Response.json({ error: `model "${MODEL}" not found` }, { status: 404 });
    },
  });
  cleanups.push(answer.open);
  const { turnId } = await r.send("first");
  await r.app.handlers["reply.send"]({ id: "q1", threadId: r.thread.id, messageId: "m-q1", text: "second", model: MODEL, numCtx: 16384 }, { clientId: 1 });
  await until(() => r.heard.some((h) => { const c = changeOf(h); return c?.kind === "is" && c.reply.id === "q1" && c.reply.stage === "queued"; }), "the waiting message told");
  const before = r.heard.length;
  answer.open();
  await until(() => r.terminal(turnId) !== undefined && r.heard.slice(before).some((h) => { const c = changeOf(h); return c !== undefined && changedId(c) === "q1"; }), "the waiting message moved on");
  const last = r.heard.findIndex((h) => { const s = saidOf(h); return s?.turnId === turnId && s.event.type === "error"; });
  const moved = r.heard.findIndex((h, i) => { const c = changeOf(h); return i >= before && c !== undefined && changedId(c) === "q1"; });
  expect(r.terminal(turnId)).toMatchObject({ type: "error", code: "model-not-found" });
  expect(changeOf(r.heard[moved]!)).toMatchObject({ kind: "is", reply: { id: "q1", stage: "held" } });
  expect(last).toBeGreaterThanOrEqual(before);
  expect(moved).toBeGreaterThan(last);
});

it("a reply that fails on its own starts over in the same place, and only its second failure is said", async () => {
  const r = rig({ chat: (n) => body(piece(n === 1 ? "first try " : "second try "), failing(`crash ${n}`)) });
  const { id, turnId } = await r.send("go");
  await r.ended(turnId);
  const parts = r.heard.flatMap((h) => { const w = wordsOf(h); return w?.id === id ? [w.part] : []; });
  expect(parts).toEqual([
    { type: "text", from: 0, text: "first try " },
    { type: "again" },
    { type: "text", from: 0, text: "second try " },
  ]);
  expect(r.events(turnId).filter((e) => e.type === "error")).toEqual([expect.objectContaining({ code: "stream-error", message: "crash 2" })]);
});

it("a second attempt keeps none of the first attempt's words, on screen or on disk", async () => {
  const onDiskAtAgain: string[][] = [];
  const r = rig({
    chat: (n) => (n === 1 ? body(piece("first try "), failing("crash")) : body(piece("second try"), DONE)),
    onPush: (channel, payload) => {
      if (channel === "reply.words" && (payload as WordsPayload).part.type === "again") onDiskAtAgain.push(r.rows().map((m) => m.content));
    },
  });
  const { id, turnId } = await r.send("go");
  await r.ended(turnId);
  expect(onDiskAtAgain).toEqual([["go"]]);
  const again = r.heard.findIndex((h) => wordsOf(h)?.part.type === "again");
  const before = r.heard.slice(0, again).flatMap((h) => { const w = wordsOf(h); return w?.id === id ? [w.part] : []; });
  const after = r.heard.slice(again + 1).flatMap((h) => { const w = wordsOf(h); return w?.id === id ? [w.part] : []; });
  expect(before).toEqual([{ type: "text", from: 0, text: "first try " }]);
  expect(after).toEqual([{ type: "text", from: 0, text: "second try" }]);
  expect(r.terminal(turnId)).toMatchObject({ type: "done", message: { content: "second try" } });
  expect(r.rows().map((m) => [m.role, m.content])).toEqual([["user", "go"], ["assistant", "second try"]]);
});
