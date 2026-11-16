import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Params } from "@gates-local/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { sendStarted } from "../chat/send-started.ts";
import { ModelActionError, type ModelLoader } from "../runtime/load.ts";
import type { ModelInfo } from "../runtime/types.ts";
import { openThreadStore } from "../threads/store.ts";
import { until } from "../../test/send-rig.ts";

const MODEL = "qwen3.5:9b";
const CHAT_MODEL: ModelInfo = { name: MODEL, digest: "d", sizeBytes: 6_600_000_000, modifiedAt: "2026-11-01T00:00:00Z", capabilities: ["completion"] };
const READY = { state: "ready" as const, owner: "external" as const, baseUrl: "http://fake" };
const SHOW: unknown = JSON.parse(readFileSync(new URL("../fit/fixtures/show-qwen3-5-9b.json", import.meta.url), "utf8"));

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).toReversed()) await clean();
  vi.unstubAllGlobals();
});

const turnover = () => new Promise((r) => setTimeout(r, 50));

function fakeOllama() {
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    const where = new URL(String(url)).pathname;
    if (where === "/api/show") return Response.json(SHOW);
    if (where === "/api/ps") return Response.json({ models: [] });
    if (where === "/api/tags") return Response.json({ models: [{ name: MODEL, size: 6600000000, digest: "d", modified_at: "2026-11-01T00:00:00Z" }] });
    if (where === "/api/chat") return new Response(`${JSON.stringify({ model: MODEL, message: { role: "assistant", content: "ok" }, done: true, done_reason: "stop" })}\n`);
    throw new Error(`Unexpected request: ${where}`);
  });
}

function rig(options: { installed?: readonly ModelInfo[]; reserve?: Pick<ModelLoader, "reserve">["reserve"] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "gl-handlers-refuse-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = openThreadStore(path.join(dir, "threads.sqlite"));
  const thread = store.createThread({ title: "A" });
  fakeOllama();
  const catalog = { installed: options.installed ?? [CHAT_MODEL] };
  const app = createApp({
    store,
    runtime: { status: () => READY, baseUrl: () => "http://fake", onChange: () => () => {}, ensure: async () => READY, lookIfDown: async () => READY },
    catalog: { current: () => catalog.installed, refresh: async () => ({ models: catalog.installed, changed: false }), onChange: () => () => {}, stop: () => {} },
    push: () => {},
    fit: { runNvidiaSmi: async (args) => (args[0]?.startsWith("--query-gpu") ? "16384, 1024, 15360\n" : ""), readMeminfo: async () => "MemAvailable: 32000000 kB\n" },
    ...(options.reserve === undefined ? {} : { models: { handlers: {}, loader: { reserve: options.reserve } } }),
  });
  cleanups.push(async () => { await app.shutdown(); store.close(); });
  const send = (id: string, text: string, extra: Partial<Params<"reply.send">> = {}) =>
    app.handlers["reply.send"]({ id, threadId: thread.id, messageId: `m-${id}`, text, model: MODEL, numCtx: 16384, ...extra } as Params<"reply.send">, { clientId: 1 });
  const rows = () => store.getThread(thread.id).messages.map((m) => [m.role, m.content, m.interrupted === true]);
  return { app, store, thread, catalog, send, rows };
}

describe("what reply.send refuses, and why", () => {
  it("a Retry into a chat where a message waits, with no reply on its way, is refused as turn-active", async () => {
    const r = rig({ installed: [] });
    const question = r.store.appendMessage({ threadId: r.thread.id, role: "user", content: "first" });
    expect(await r.send("waiting", "second")).toMatchObject({ answer: "done", reply: { id: "waiting", stage: "queued" } });
    await turnover();
    expect(r.app.activeTurns()).toBe(0);
    r.catalog.installed = [CHAT_MODEL];
    await expect(r.send("retry", "first", { retryOf: question.id })).rejects.toMatchObject({ code: "turn-active" });
    expect(r.app.activeTurns()).toBe(0);
  });

  it("a Retry while the server is stopping is refused as shutting-down", async () => {
    const r = rig();
    const question = r.store.appendMessage({ threadId: r.thread.id, role: "user", content: "first" });
    await r.app.shutdown();
    await expect(r.send("retry", "first", { retryOf: question.id })).rejects.toMatchObject({ code: "shutting-down" });
  });

  it("a send refused while its model is being removed waits on hold with that reason, not as a start that ended unexplained", async () => {
    const r = rig({ reserve: (model) => { throw new ModelActionError("model-removing", `${model} is being removed.`); } });
    const answer = await r.send("a", "hello");
    expect(answer).toMatchObject({ answer: "done", reply: { id: "a", stage: "held", held: { why: "refused", code: "model-removing", message: `${MODEL} is being removed.` } } });
    expect(r.app.activeTurns()).toBe(0);
    expect(r.rows()).toEqual([]);
  });
});

describe("what a Retry replaces", () => {
  it("a Retry of an older question after a newer one was asked becomes a new question, and keeps the newer one", async () => {
    const r = rig();
    const older = r.store.appendMessage({ threadId: r.thread.id, role: "user", content: "first" });
    r.store.appendMessage({ threadId: r.thread.id, role: "assistant", content: "an answer" });
    r.store.appendMessage({ threadId: r.thread.id, role: "user", content: "second" });
    r.store.appendMessage({ threadId: r.thread.id, role: "assistant", content: "cut o", interrupted: true });
    await sendStarted(r.app, { threadId: r.thread.id, content: "first", model: MODEL, numCtx: 16384, retryOf: older.id });
    await until(() => r.app.activeTurns() === 0, "the Retry's reply");
    expect(r.rows()).toEqual([
      ["user", "first", false], ["assistant", "an answer", false],
      ["user", "second", false], ["assistant", "cut o", true],
      ["user", "first", false], ["assistant", "ok", false],
    ]);
  });
});
