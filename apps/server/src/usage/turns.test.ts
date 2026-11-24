// Usage from the turn path: every model request a reply makes is counted
// once with the figures its done line reported, through the real app over a
// stubbed runtime (the shape tools.test.ts uses).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../app.ts";
import { sendStarted } from "../chat/send-started.ts";
import { createSources } from "../sources/index.ts";
import { openThreadStore, type ThreadStore } from "../threads/store.ts";
import { createUsage, type Usage } from "./index.ts";
import { chatCatalog } from "../../test/send-rig.ts";

const dirs: string[] = [];
const scratch = () => {
  const root = mkdtempSync(path.join(tmpdir(), "gl-usage-turns-"));
  dirs.push(root);
  return root;
};
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ndjson = (items: unknown[]) => new Response(items.map((i) => JSON.stringify(i)).join("\n") + "\n");
const done = (promptTokens: number, completionTokens: number, extra: Record<string, unknown> = {}) => ({ model: "m", message: { content: "" }, ...extra, done: true, prompt_eval_count: promptTokens, eval_count: completionTokens });
/** An Ollama reply that never finishes; it rejects when the turn aborts the request. */
const hang = (signal: AbortSignal | null | undefined) => new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
const READY = { state: "ready", owner: "external", baseUrl: "http://fake" } as const;

type Chat = (n: number, signal: AbortSignal | null | undefined) => Response | Promise<Response>;

async function rig(chat: Chat) {
  const root = scratch();
  const sources = createSources({ dataDir: path.join(root, "data") });
  const file = path.join(root, "notes.txt");
  writeFileSync(file, "hello");
  await sources.add({ kind: "file", path: file });
  const store = openThreadStore(path.join(root, "threads.sqlite"));
  const pushed: string[] = [];
  const usage = createUsage({ file: path.join(root, "usage.sqlite"), push: (channel) => pushed.push(channel), replies: () => store.replyUsage() });
  let chats = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/api/show") return Response.json({ capabilities: ["tools"] });
    if (pathname === "/api/ps") return Response.json({ models: [{ name: "m", model: "m", size: 1000, size_vram: 1000, context_length: 16384, expires_at: "later", digest: "d" }] });
    if (pathname === "/api/tags") return Response.json({ models: [] });
    return chat(++chats, init?.signal);
  }));
  const app = createApp({
    store, sources, usage, toolsEnabled: () => false,
    runtime: { status: () => READY, baseUrl: () => "http://fake", onChange: () => () => {}, ensure: async () => READY, lookIfDown: async () => READY },
    catalog: chatCatalog(),
    push: () => {},
    fit: { runNvidiaSmi: async (args) => (args[0]?.startsWith("--query-gpu") ? "16384, 1024, 15360\n" : ""), readMeminfo: async () => "MemAvailable: 32000000 kB\n" },
  });
  const read = async () => (await usage.handlers["usage.read"]({ since: 0 }, { clientId: 1 })).rows.map((r) => [r.model, r.promptTokens, r.completionTokens, r.replies]);
  const send = (threadId: string, extra: Record<string, unknown> = {}) => sendStarted(app, { threadId, content: "hi", model: "m", numCtx: 16384, ...extra }, { clientId: 1 });
  return { app, store, usage, pushed, read, send, close: async () => { await app.shutdown(); usage.close(); store.close(); } };
}

const close = async (t: { close: () => Promise<void> }) => t.close();

describe("usage from turns", () => {
  it("counts a reply once with the figures its request reported, and pushes the change", async () => {
    const t = await rig(() => ndjson([{ model: "m", message: { content: "hello" }, done: false }, done(11, 3, { eval_duration: 2e9, prompt_eval_duration: 5e8, total_duration: 3e9 })]));
    try {
      const thread = t.store.createThread();
      await (await t.send(thread.id)).ended;
      expect(await t.read()).toEqual([["m:latest", 11, 3, 1]]);
      // Ollama's nanoseconds arrive as milliseconds.
      expect(t.usage.handlers["usage.read"]({ since: 0 }).rows[0]).toMatchObject({ decodeTokens: 3, decodeMs: 2000, readTokens: 11, readMs: 500, wallMs: 3000 });
      expect(t.pushed).toEqual(["usage.changed"]);
    } finally { await close(t); }
  });

  it("a usage row holds an hour, a model and its sums: no words, chat or title", async () => {
    const t = await rig(() => ndjson([{ model: "m", message: { content: "a private answer" }, done: false }, done(11, 3, { eval_duration: 2e9, prompt_eval_duration: 5e8, total_duration: 3e9 })]));
    try {
      const thread = t.store.createThread({ title: "Secret plans" });
      await (await t.send(thread.id, { content: "a private question" })).ended;
      const read = t.usage.handlers["usage.read"]({ since: 0 });
      expect(read.rows).toHaveLength(1);
      expect(Object.keys(read.rows[0]!).toSorted()).toEqual(["completionTokens", "decodeMs", "decodeTokens", "hour", "model", "promptTokens", "readMs", "readTokens", "replies", "wallMs"]);
      const said = JSON.stringify(read);
      for (const secret of [thread.id, "Secret plans", "a private question", "a private answer"]) expect(said).not.toContain(secret);
    } finally { await close(t); }
  });

  it("a tool turn counts each of its requests once and is one reply", async () => {
    const t = await rig((n) => (n === 1
      ? ndjson([{ message: { tool_calls: [{ function: { name: "read", arguments: { path: "/library" } } }] }, done: true, prompt_eval_count: 100, eval_count: 10 }])
      : ndjson([{ message: { content: "found it" }, done: false }, done(150, 20)])));
    try {
      const thread = t.store.createThread();
      await (await t.send(thread.id, { tools: true })).ended;
      expect(t.store.getThread(thread.id).messages.at(-1)).toMatchObject({ role: "assistant", content: "found it" });
      expect(await t.read()).toEqual([["m:latest", 250, 30, 1]]);
    } finally { await close(t); }
  });

  it("a reply stopped before its request reported counts nothing", async () => {
    const t = await rig((_, signal) => hang(signal));
    try {
      const thread = t.store.createThread();
      const { turnId, ended } = await t.send(thread.id);
      expect(t.app.activeTurns()).toBe(1);
      await t.app.handlers["reply.stop"]({ id: turnId }, { clientId: 1 });
      await ended;
      expect(await t.read()).toEqual([]);
    } finally { await close(t); }
  });

  it("a tool turn stopped in its second request counts what the first reported", async () => {
    const t = await rig((n, signal) => (n === 1
      ? ndjson([{ message: { tool_calls: [{ function: { name: "read", arguments: { path: "/library" } } }] }, done: true, prompt_eval_count: 100, eval_count: 10 }])
      : hang(signal)));
    try {
      const thread = t.store.createThread();
      const { turnId, ended } = await t.send(thread.id, { tools: true });
      await vi.waitFor(async () => expect(await t.read()).toEqual([["m:latest", 100, 10, 1]]));
      await t.app.handlers["reply.stop"]({ id: turnId }, { clientId: 1 });
      await ended;
      expect(await t.read()).toEqual([["m:latest", 100, 10, 1]]);
    } finally { await close(t); }
  });

  it("regenerating counts again, and deleting the thread leaves usage as it was", async () => {
    const t = await rig(() => ndjson([{ model: "m", message: { content: "hello" }, done: false }, done(11, 3)]));
    try {
      const thread = t.store.createThread();
      const first = await t.send(thread.id);
      await first.ended;
      // Retry as the client sends it: a new question row that replaces the old one and its reply.
      const again = await t.send(thread.id, { retryOf: first.userMessage.id });
      await again.ended;
      expect(again.replayed).toBeUndefined();
      expect(await t.read()).toEqual([["m:latest", 22, 6, 2]]);
      await t.app.handlers["threads.delete"]({ threadId: thread.id }, { clientId: 1 });
      expect(() => t.store.getThread(thread.id)).toThrow();
      expect(await t.read()).toEqual([["m:latest", 22, 6, 2]]);
    } finally { await close(t); }
  });
});

const seed = (store: ThreadStore) => {
  const thread = store.createThread();
  store.appendMessage({ threadId: thread.id, role: "user", content: "q" });
  store.appendMessage({ threadId: thread.id, role: "assistant", content: "a", model: "qwen3.5:9b", createdAt: Date.UTC(2026, 10, 5, 12), stats: { promptTokens: 40, completionTokens: 9, numCtx: 8192, evalDurationMs: 300, promptEvalDurationMs: 20, durationMs: 400 } });
  store.appendMessage({ threadId: thread.id, role: "assistant", content: "b", model: "gemma3", createdAt: Date.UTC(2026, 10, 6, 12), stats: { promptTokens: 7, completionTokens: 2, numCtx: 8192 } });
  // Saved before stats existed, and a stopped reply: neither reported figures.
  store.appendMessage({ threadId: thread.id, role: "assistant", content: "c", model: "qwen3.5:9b", createdAt: Date.UTC(2026, 10, 4, 12) });
  store.appendMessage({ threadId: thread.id, role: "assistant", content: "d", model: "qwen3.5:9b", createdAt: Date.UTC(2026, 10, 6, 13), stats: { numCtx: 8192 }, interrupted: true });
};

describe("the one-time fill", () => {

  it("fills from stored replies on first start, says what they lack, and never runs again", () => {
    const root = scratch();
    const store = openThreadStore(path.join(root, "threads.sqlite"));
    seed(store);
    const lines: string[] = [];
    let timesTheStoredRepliesWereRead = 0;
    const replies = () => { timesTheStoredRepliesWereRead++; return store.replyUsage(); };
    const open = (): Usage => createUsage({ file: path.join(root, "usage.sqlite"), push: () => {}, log: (line) => lines.push(line), replies });
    let usage = open();
    try {
      const first = usage.handlers["usage.read"]({ since: 0 }, { clientId: 1 });
      expect(first).toMatchObject({
        models: ["qwen3.5:9b", "gemma3:latest"],
        rows: [
          { hour: Date.UTC(2026, 10, 5, 12), model: "qwen3.5:9b", promptTokens: 40, completionTokens: 9, replies: 1, decodeTokens: 9, decodeMs: 300, readTokens: 40, readMs: 20, wallMs: 400 },
          { hour: Date.UTC(2026, 10, 6, 12), model: "gemma3:latest", promptTokens: 7, completionTokens: 2, replies: 1, decodeTokens: 0, decodeMs: 0, readMs: 0, wallMs: 0 },
        ],
      });
      expect(lines).toEqual(["usage: filled from 2 stored replies; 2 stored replies have no token counts and are not included; 1 counted reply has no timings"]);
      usage.close();
      usage = open();
      expect(usage.handlers["usage.read"]({ since: 0 }, { clientId: 1 })).toEqual(first);
      expect(lines).toHaveLength(1);
      expect(timesTheStoredRepliesWereRead).toBe(1);
    } finally {
      usage.close();
      store.close();
    }
  });
});

describe("a usage write that fails", () => {
  it("is logged and dropped: the reply's turn gets no error and no window is told of a change", () => {
    const lines: string[] = [];
    const pushed: string[] = [];
    const usage = createUsage({ file: path.join(scratch(), "usage.sqlite"), push: (channel) => pushed.push(channel), log: (line) => lines.push(line) });
    usage.close();
    expect(() => usage.record("m", { promptTokens: 4, completionTokens: 2 }, true)).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^usage: could not record a request \(/);
    expect(pushed).toEqual([]);
  });
});
