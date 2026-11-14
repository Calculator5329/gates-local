// The server sends its queue: a message queued behind a reply goes when that reply ends and
// leaves the queue at its start; a Stop holds it until Send now.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Channel, Payload, QueuedMessage } from "@gates-local/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
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
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    const where = new URL(String(url)).pathname;
    if (where === "/api/show") return Response.json(show);
    if (where === "/api/ps") return Response.json({ models: [] });
    if (where === "/api/tags") return Response.json({ models: [{ name: MODEL, size: 6600000000, digest: "d", modified_at: "2026-11-01T00:00:00Z" }] });
    if (where === "/api/chat") return new Response(`${JSON.stringify({ model: MODEL, message: { role: "assistant", content: "ok" }, done: true, done_reason: "stop" })}\n`);
    throw new Error(`Unexpected request: ${where}`);
  });
  let open!: () => void;
  const gate = new Promise<void>((done) => { open = done; });
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
        await gate;
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
  return { app, db, thread, open, starts, queued, entry, h: app.handlers as Required<typeof app.handlers> };
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
