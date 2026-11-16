import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Channel, Message, ReplyChange } from "@gates-local/contracts";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createApp } from "../app.ts";
import { createQueuePump } from "../app/queue-pump.ts";
import type { TurnSaid } from "../app/turn.ts";
import type { ModelInfo, RuntimeState, RuntimeStatus } from "../runtime/types.ts";
import { openThreadStore, type ThreadStore } from "../threads/store.ts";
import { chatCatalog } from "../../test/send-rig.ts";
import { entry, waits } from "./queue-testing.ts";
import { type Ready, type RepliesDeps, createReplies } from "./replies.ts";
import { sendTaken } from "./send-started.ts";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    mkdirSync: vi.fn((...a: Parameters<typeof fs.mkdirSync>) => (String(a[0]).startsWith("/") ? fs.mkdirSync(...a) : undefined)),
    writeFileSync: vi.fn((...a: Parameters<typeof fs.writeFileSync>) => (String(a[0]).startsWith("/") ? fs.writeFileSync(...a) : undefined)),
    renameSync: vi.fn((...a: Parameters<typeof fs.renameSync>) => (String(a[0]).startsWith("/") ? fs.renameSync(...a) : undefined)),
  };
});

const MODEL = "qwen3.5:9b";
const idle: Ready = { chat: true, anyWork: false, busy: () => false };
const question = (id: string, threadId = "t1"): Message => ({ id, threadId, role: "user", content: id, createdAt: 1 });
const WARM = { cold: false, drawing: false };
const PICTURE = { draw: { preset: "sdxl", width: 1024, height: 1024 } };
const CHAT_MODEL: ModelInfo = { name: MODEL, digest: "d", sizeBytes: 6_600_000_000, modifiedAt: "2026-11-01T00:00:00Z", capabilities: ["completion"] };
const EMBED_MODEL: ModelInfo = { name: "nomic-embed-text", digest: "e", sizeBytes: 270_000_000, modifiedAt: "2026-11-01T00:00:00Z", capabilities: ["embedding"] };
const NOTHING_SAVED = { getMessage: () => undefined } as unknown as ThreadStore;
const READY: RuntimeStatus = { state: "ready", owner: "external", baseUrl: "http://fake" };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const clean of cleanups.splice(0).toReversed()) await clean();
});

function store(file?: string, more: Partial<RepliesDeps> = {}) {
  const heard: ReplyChange[] = [];
  const logged: string[] = [];
  const q = createReplies({
    file, log: (line) => logged.push(line), told: (c) => heard.push(c), saved: () => undefined, deleting: () => false, closing: () => false,
    cut: () => undefined, clock: () => undefined, ...more,
  });
  const running = (turnId: string, threadId = "t1", how = WARM) => {
    waits(q, entry(turnId, threadId));
    expect(q.take(turnId, turnId, 1)).toBe(1);
    q.begun(turnId);
    expect(q.started(turnId, 1, question(`m-${turnId}`, threadId), "m", how)).toBe(true);
  };
  return { q, heard, logged, running };
}

function dataFile(): string {
  const root = path.join(os.homedir(), ".cache", "gates-local-tests");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "queue-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "queue.json");
}

function steps(file?: string): readonly string[] {
  const { q, logged, running } = store(file);
  waits(q, entry("a"));
  waits(q, entry("b"));
  q.edit({ id: "b", open: true }, 1);
  q.remove({ id: "a" });
  running("turn-1", "t2");
  q.notify();
  return logged;
}

const turnover = () => new Promise<void>((done) => { setImmediate(done); });

async function turnsOver(times: number): Promise<void> {
  for (let i = 0; i < times; i++) await turnover();
}

const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!ok()) throw new Error(`timed out waiting for ${what}`);
};

const fresh = (id: string, threadId: string) => ({ id, threadId, messageId: `m-${id}`, text: id, model: "m", numCtx: 4096 });

type Heard = { readonly said: TurnSaid } | { readonly channel: Channel; readonly payload: unknown };

const changeOf = (h: Heard): ReplyChange | undefined => ("channel" in h && h.channel === "reply.changed" ? (h.payload as ReplyChange) : undefined);

function appRig() {
  const root = path.join(os.homedir(), ".cache", "gates-local-tests");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "replies-calls-"));
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
  const signal = new AbortController().signal;
  const log: Heard[] = [];
  const app = createApp({
    store: db,
    runtime: { status: () => READY, baseUrl: () => "http://fake", onChange: () => () => {}, ensure: async () => READY, lookIfDown: async () => READY },
    catalog: chatCatalog(),
    push: (channel, payload) => { log.push({ channel, payload }); },
    turnSaid: (s) => { log.push({ said: s }); },
    fit: { runNvidiaSmi: async (args) => (args[0]?.startsWith("--query-gpu") ? "16384, 1024, 15360\n" : ""), readMeminfo: async () => "MemAvailable: 32000000 kB\n" },
    models: { handlers: {}, loader: { reserve: () => ({
      baseUrl: "http://fake", signal, cold: false, firstToken: () => {}, end: () => {},
      admit: async (_ctx, options) => {
        if (options?.fit === undefined) throw new Error("missing app fit");
        return options.fit(signal, { handoff: undefined, leave: async () => undefined });
      },
    }) } },
  });
  cleanups.push(async () => { await app.shutdown(); db.close(); });
  const saidAt = (turnId: string, type: string) => log.findIndex((h) => "said" in h && h.said.turnId === turnId && h.said.event.type === type);
  const toldAt = (id: string, ok: (c: ReplyChange) => boolean) => log.findIndex((h) => { const c = changeOf(h); return c !== undefined && (c.kind === "is" ? c.reply.id : c.id) === id && ok(c); });
  return { app, thread, saidAt, toldAt };
}

describe("the reply store's calls and what they answer", () => {
  it("the pump sends a chat message only once Ollama is ready and a chat model is installed; a picture goes without either", async () => {
    let state: RuntimeState = "stopped";
    let installed: readonly ModelInfo[] = [CHAT_MODEL];
    let turns = 0;
    const begun: string[] = [];
    const { q } = store();
    const now = (): RuntimeStatus => ({ state, owner: "external", baseUrl: "http://fake" });
    const pump = createQueuePump({
      replies: q, turns: new Map(), byThread: new Map(), closing: () => false, store: NOTHING_SAVED, settings: undefined,
      catalog: { current: () => installed, refresh: async () => ({ models: installed, changed: false }), onChange: () => () => {}, stop: () => {} },
      runtime: { status: now, baseUrl: () => "http://fake", onChange: () => () => {}, ensure: async () => now(), lookIfDown: async () => now() },
      newId: () => `turn-${++turns}`,
      begin: (params, taken) => {
        begun.push(params.content);
        return { turnId: taken.turnId };
      },
    });
    waits(q, entry("a"));
    pump.pump();
    await turnsOver(4);
    expect(begun, "Ollama is down, with a chat model installed").toEqual([]);
    state = "ready";
    installed = [EMBED_MODEL];
    pump.pump();
    await turnsOver(4);
    expect(begun, "Ollama is ready, with no chat model installed").toEqual([]);
    state = "stopped";
    installed = [];
    waits(q, entry("p", "t2", PICTURE));
    pump.pump();
    await until(() => begun.length === 1, "the picture to go");
    expect(begun).toEqual(["p"]);
    state = "ready";
    installed = [CHAT_MODEL];
    pump.pump();
    await until(() => begun.length === 2, "the chat message to go");
    expect(begun).toEqual(["p", "a"]);
  });

  it("the picker hands over a Send now message as a Send now, with its words and its yes, and a plain one as not", () => {
    const { q } = store();
    waits(q, entry("a"));
    waits(q, entry("b", "t2"));
    expect(q.pick(idle)).toMatchObject({ id: "a", now: false, words: { text: "a", messageId: "m-a" } });
    q.now({ id: "b", consent: { kind: "standing" } });
    expect(q.pick(idle)).toMatchObject({ id: "b", threadId: "t2", now: true, consent: { kind: "standing" }, words: { text: "b", messageId: "m-b" } });
  });

  it("with no file to keep them in, waiting messages never touch the disk", () => {
    vi.mocked(mkdirSync).mockClear();
    vi.mocked(writeFileSync).mockClear();
    vi.mocked(renameSync).mockClear();
    expect(steps(), "nothing failed to save either").toEqual([]);
    expect(vi.mocked(mkdirSync)).not.toHaveBeenCalled();
    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
    expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
    const file = dataFile();
    steps(file);
    expect(vi.mocked(writeFileSync), "the same steps with a file write it").toHaveBeenCalled();
    expect(vi.mocked(renameSync).mock.calls.some((c) => c[1] === file)).toBe(true);
  });

  it("a start told its model is loading answers yes only when that changed its record: not twice, not for an unknown turn, not once its question is saved", () => {
    const { q } = store();
    waits(q, entry("a"));
    expect(q.take("a", "turn-a", 1)).toBe(1);
    expect(q.loading("turn-a")).toBe(true);
    expect(q.loading("turn-a"), "it is loading already").toBe(false);
    expect(q.loading("turn-x")).toBe(false);
    q.begun("turn-a");
    expect(q.started("turn-a", 1, question("m-a"), "m", { cold: true, drawing: false })).toBe(true);
    expect(q.loading("turn-a")).toBe(false);
  });

  it("a refused start reaches the windows when they are next told, not at the refusal", () => {
    const { q, heard } = store();
    waits(q, entry("a"));
    expect(q.take("a", "turn-a", 1)).toBe(1);
    q.begun("turn-a");
    const told = heard.length;
    q.refused("turn-a", 1, { code: "wont-fit", message: "too big" });
    expect(heard, "nothing yet: the chat's error event goes first").toHaveLength(told);
    q.notify();
    expect(heard.slice(told)).toMatchObject([{ kind: "is", reply: { id: "a", stage: "held", held: { why: "refused", code: "wont-fit" } } }]);
  });

  it("a stream event for a reply that is no longer being written shows no stage, so its clock is left alone", () => {
    const { q, running } = store();
    running("turn-1");
    expect(q.heard("turn-1", { type: "delta", text: "some" })).toBe("writing");
    q.stop({ id: "turn-1" });
    expect(q.heard("turn-1", { type: "delta", text: "more" })).toBeUndefined();
    expect(q.heard("turn-1", { type: "tool", step: { callId: "c1", state: "running" } })).toBeUndefined();
    q.ended("turn-1", { how: "stopped", by: { who: "person" } }, 2);
    expect(q.heard("turn-1", { type: "delta", text: "late" })).toBeUndefined();
  });

  it("a reply run once more shows the stage it runs in again, and none once a Stop has taken it or it has ended", () => {
    const { q, running } = store();
    running("turn-1");
    q.heard("turn-1", { type: "delta", text: "first try" });
    expect(q.retrying("turn-1"), "its model is ready: it works on the reply again at once").toBe("thinking");
    running("turn-2", "t2", { cold: true, drawing: false });
    expect(q.retrying("turn-2"), "its model is still loading").toBe("loading");
    q.stop({ id: "turn-1" });
    expect(q.retrying("turn-1")).toBeUndefined();
    q.ended("turn-2", { how: "done" }, 3);
    expect(q.retrying("turn-2")).toBeUndefined();
  });

  it("a turn's record is found by its turn while it is on its way, and no longer once its reply has ended", () => {
    const { q, running } = store();
    running("turn-1");
    expect(q.of("turn-1")).toMatchObject({ id: "turn-1", stage: "thinking", turnId: "turn-1" });
    q.ended("turn-1", { how: "done" }, 2);
    expect(q.of("turn-1")).toBeUndefined();
    running("turn-2");
    q.ended("turn-2", { how: "failed", code: "model-error", message: "boom" }, 3);
    expect(q.of("turn-2")).toBeUndefined();
  });

  it("a turn's saved question is found until its reply has ended, though the question stays in the chat", () => {
    const inChat = new Map<string, Message>();
    const { q, running } = store(undefined, { saved: (id) => inChat.get(id) });
    running("turn-1");
    inChat.set("m-turn-1", question("m-turn-1"));
    expect(q.question("turn-1")).toEqual(question("m-turn-1"));
    q.ended("turn-1", { how: "done", replyId: "r-1" }, 2);
    expect(q.question("turn-1")).toBeUndefined();
  });

  it("a new message waits behind one of its chat that is open in a composer, as it would behind that one waiting; one opened from hold is not in its way", () => {
    const { q } = store();
    waits(q, entry("a"));
    q.edit({ id: "a", open: true }, 1);
    expect(q.send(fresh("b", "t1"), { at: 1, behind: "reply", busy: false, turnId: "turn-b" })).toMatchObject({ kind: "answer", answer: { reply: { id: "b", stage: "queued" } } });
    waits(q, entry("c", "t2"));
    q.hold({ id: "c" });
    q.edit({ id: "c", open: true }, 1);
    expect(q.send(fresh("d", "t2"), { at: 1, behind: "reply", busy: false, turnId: "turn-d" })).toMatchObject({ kind: "start" });
  });

  it("the windows hear a reply has begun only after the chat has said its question went in", async () => {
    const r = appRig();
    const { id, turnId } = await sendTaken(r.app, { threadId: r.thread.id, content: "hi", model: MODEL, numCtx: 16384 }, { clientId: 1 });
    await until(() => r.saidAt(turnId, "done") >= 0, "the reply's end");
    const start = r.saidAt(turnId, "start");
    expect(start).toBeGreaterThanOrEqual(0);
    const asked = r.toldAt(id, (c) => c.kind === "is" && "questionId" in c.reply);
    expect(asked, "the record with its question saved").toBeGreaterThan(start);
  });

  it("the windows hear a reply has ended only after the chat's last event for it", async () => {
    const r = appRig();
    const { id, turnId } = await sendTaken(r.app, { threadId: r.thread.id, content: "hi", model: MODEL, numCtx: 16384 }, { clientId: 1 });
    await until(() => r.saidAt(turnId, "done") >= 0 && r.toldAt(id, (c) => c.kind === "is" && c.reply.stage === "done") >= 0, "the reply's end, told");
    expect(r.toldAt(id, (c) => c.kind === "is" && c.reply.stage === "done")).toBeGreaterThan(r.saidAt(turnId, "done"));
  });
});
