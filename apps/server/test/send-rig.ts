// The whole app over a temporary store and a fake runtime, for tests of sends, the queue and
// Stop: each send's start waits at a gate the test opens, and a reply can be held mid-stream.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Channel, Params, Payload, Reply, ReplyChange, ReplyRecord } from "@gates-local/contracts";
import { afterEach, vi } from "vitest";
import { createApp } from "../src/app.ts";
import type { Rules } from "../src/chat/reply.ts";
import { openThreadStore } from "../src/threads/store.ts";

export const MODEL = "qwen3.5:9b";
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  // the app closes over the fake runtime: what it still asks while closing never reaches the network
  for (const clean of cleanups.splice(0).toReversed()) await clean();
  vi.unstubAllGlobals();
});

export const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!ok()) throw new Error(`timed out waiting for ${what}`);
};

export const WAITING: ReadonlySet<Reply["stage"]> = new Set(["queued", "held", "next", "editing"]);

export const settle = () => new Promise((r) => setTimeout(r, 50));

const line = (content: string, done: boolean) => new TextEncoder().encode(`${JSON.stringify({ model: MODEL, message: { role: "assistant", content }, done, ...(done ? { done_reason: "stop" } : {}) })}\n`);

export interface RigHooks {
  readonly fileOwnersRead?: () => void;
  /** Each reply writes its first words and then waits for `finish` (or a Stop). */
  readonly drip?: true;
  /** One rule of the reply table turned off, to see the test that guards it fail (src/chat/reply-rules.test.ts). */
  readonly rules?: Rules;
}

export function rig(hooks: RigHooks = {}) {
  const root = path.join(os.homedir(), ".cache", "gates-local-tests");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "queue-send-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = openThreadStore(path.join(dir, "threads.sqlite"));
  const thread = db.createThread({ title: "A" });
  const show: unknown = JSON.parse(readFileSync(new URL("../src/fit/fixtures/show-qwen3-5-9b.json", import.meta.url), "utf8"));
  /** Each chat request's model and context. */
  const asked: { model: string; numCtx: number }[] = [];
  /** The held replies' last words, one a reply in flight. */
  const dripping: (() => void)[] = [];
  const finish = () => { for (const last of dripping.splice(0)) last(); };
  const chat = (stop: AbortSignal | null | undefined): Response => {
    if (hooks.drip !== true) return new Response(line("ok", true));
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(line("some words", false));
      const cut = () => controller.error(stop?.reason);
      stop?.addEventListener("abort", cut, { once: true });
      dripping.push(() => {
        if (stop?.aborted === true) return;
        stop?.removeEventListener("abort", cut);
        controller.enqueue(line("", true));
        controller.close();
      });
    } }));
  };
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const where = new URL(String(url)).pathname;
    if (where === "/api/chat") {
      const body = JSON.parse(String(init?.body)) as { model: string; options: { num_ctx: number } };
      asked.push({ model: body.model, numCtx: body.options.num_ctx });
    }
    if (where === "/api/show") return Response.json(show);
    if (where === "/api/ps") return Response.json({ models: [] });
    if (where === "/api/tags") return Response.json({ models: [{ name: MODEL, size: 6600000000, digest: "d", modified_at: "2026-11-01T00:00:00Z" }] });
    if (where === "/api/chat") return chat(init?.signal);
    throw new Error(`Unexpected request: ${where}`);
  });
  // each send's admit waits here: openOne lets the next one through, open lets every one through
  const waiting: (() => void)[] = [];
  let allowed = 0;
  let all = false;
  const pass = () => {
    for (;;) {
      const go = waiting[0];
      if (go === undefined || !(all || allowed > 0)) return;
      if (!all) allowed--;
      waiting.shift();
      go();
    }
  };
  /** The next admits refuse with these, in order. */
  const refusals: Error[] = [];
  const open = () => { all = true; pass(); };
  const openOne = () => { allowed++; pass(); };
  const signal = new AbortController().signal;
  const pushes: Array<{ channel: Channel; payload: unknown }> = [];
  const model = { name: MODEL, digest: "d", sizeBytes: 6_600_000_000, modifiedAt: "2026-11-01T00:00:00Z", capabilities: ["completion" as const] };
  // a test can act at the moment the server reads who owns the attached files (inside the save)
  const store = new Proxy(db, { get: (target, key) => key === "fileOwnersRead" ? undefined : key === "fileOwners" ? () => { hooks.fileOwnersRead?.(); return target.fileOwners(); } : Reflect.get(target, key, target) });
  const app = createApp({
    store,
    dataDir: dir,
    runtime: { status: () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }), baseUrl: () => "http://fake", onChange: () => () => {}, ensure: async () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }), lookIfDown: async () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }) },
    catalog: { current: () => [model], refresh: async () => ({ models: [model], changed: false }), onChange: () => () => {}, stop: () => {} },
    push: (channel, payload) => { pushes.push({ channel, payload }); },
    fit: { runNvidiaSmi: async (args) => (args[0]?.startsWith("--query-gpu") ? "16384, 1024, 15360\n" : ""), readMeminfo: async () => "MemAvailable: 32000000 kB\n" },
    models: { handlers: {}, loader: { reserve: () => ({
      baseUrl: "http://fake", signal, cold: false, firstToken: () => {}, end: () => {},
      admit: async (_ctx, options) => {
        await new Promise<void>((go) => { waiting.push(go); pass(); });
        const no = refusals.shift();
        if (no !== undefined) throw no;
        if (options?.fit === undefined) throw new Error("missing app fit");
        return options.fit(signal, { handoff: undefined, leave: async () => undefined });
      },
    }) } },
  }, hooks.rules);
  cleanups.push(async () => { open(); finish(); await app.shutdown(); db.close(); });
  /** Every chat event pushed for this turn, in order. */
  const events = (turnId: string) => pushes.flatMap((p) => p.channel === "chat.event" && (p.payload as Payload<"chat.event">).turnId === turnId ? [(p.payload as Payload<"chat.event">).event] : []);
  /** The turn's record as last pushed. */
  const record = (turnId: string): ReplyRecord | undefined => events(turnId).findLast((e) => e.type === "reply")?.reply;
  const starts = () => pushes.flatMap((p) => {
    const e = (p.payload as Payload<"chat.event">).event;
    return p.channel === "chat.event" && e.type === "start" ? [e.userMessage.content] : [];
  });
  /** Every change of a record the windows were sent, in order. */
  const told = (): readonly ReplyChange[] => pushes.flatMap((p) => p.channel === "reply.changed" ? [p.payload as ReplyChange] : []);
  /** A record as the windows were last told, or undefined once it left. */
  const latest = (id: string): Reply | undefined => {
    const c = told().findLast((t) => (t.kind === "is" ? t.reply.id : t.id) === id);
    return c?.kind === "is" ? c.reply : undefined;
  };
  /** What waits, or waited and is taken and not yet saved, as the windows were last told, in the order each first waited. */
  const queued = (): readonly Reply[] => [...new Set(told().flatMap((t) => (t.kind === "is" && WAITING.has(t.reply.stage) ? [t.reply.id] : [])))]
    .flatMap((id) => { const r = latest(id); return r !== undefined && (WAITING.has(r.stage) || r.stage === "starting") ? [r] : []; });
  /** The turn a taken message's start runs as, from the queue's file: no window is told it. */
  const takenAs = (id: string): string | undefined => {
    try {
      const saved = JSON.parse(readFileSync(path.join(dir, "queue.json"), "utf8")) as { entries: readonly { id: string; sending?: string }[] };
      return saved.entries.find((e) => e.id === id)?.sending;
    } catch { return undefined; }
  };
  const entry = (id: string, text: string): Params<"reply.send"> => ({ id, threadId: thread.id, messageId: `m-${id}`, text, model: MODEL, numCtx: 16384 });
  return { app, db, thread, open, openOne, finish, refusals, asked, pushes, events, record, starts, told, latest, queued, takenAs, entry, h: app.handlers as Required<typeof app.handlers> };
}

export type Rig = ReturnType<typeof rig>;
