import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Channel, ImageChoice, ImageEvent, Params, ReplyChange } from "@gates-local/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { sendTaken } from "../chat/send-started.ts";
import type { ImageModule } from "../image/module.ts";
import { openThreadStore, type ThreadStore } from "../threads/store.ts";
import { chatCatalog, until } from "../../test/send-rig.ts";
import type { TurnEnd, TurnSaid } from "./turn.ts";

const DRAWN: ImageChoice = { preset: "flux2-klein-4b-pixel", width: 512, height: 512 };
const READY = { state: "ready" as const, owner: "external" as const, baseUrl: "http://fake" };

type Settled = "done" | "error" | "cancelled";
type Heard = { readonly said: TurnSaid } | { readonly channel: Channel; readonly payload: unknown };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).toReversed()) await clean();
  vi.unstubAllGlobals();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const changeOf = (h: Heard): ReplyChange | undefined => ("channel" in h && h.channel === "reply.changed" ? (h.payload as ReplyChange) : undefined);

function fakeImages(store: ThreadStore, cancelSettles: boolean) {
  const jobs = new Map<string, { settle: (state: Settled) => void; ended: Promise<void> }>();
  let n = 0;
  const generate = async (params: Params<"image.generate">) => {
    const jobId = `job-${++n}`;
    const save = (state: ImageEvent["state"], rest: Partial<ImageEvent> = {}) => store.saveImageJob({
      jobId, state,
      ...(params.threadId === undefined ? {} : { threadId: params.threadId }),
      ...(params.choice === undefined ? {} : { choice: params.choice }),
      ...(params.group === undefined ? {} : { group: params.group }),
      ...rest,
    }, params.prompt);
    save("queued");
    let done!: () => void;
    const ended = new Promise<void>((resolve) => (done = resolve));
    let settled = false;
    const settle = (state: Settled) => {
      if (settled) return;
      settled = true;
      save(state, state === "done" ? { progress: 1, imagePath: `images/${jobId}.png` } : { message: `the picture ended as ${state}` });
      done();
    };
    jobs.set(jobId, { settle, ended });
    return { jobId };
  };
  const cancel = (jobId: string) => {
    if (cancelSettles) jobs.get(jobId)?.settle("cancelled");
    return { cancelled: jobs.has(jobId) };
  };
  const image = { current: () => ({ state: "stopped", owner: "none" }), generate, cancel, wait: async (jobId: string) => { await jobs.get(jobId)?.ended; } } as unknown as ImageModule;
  const settle = (jobId: string, state: Settled) => {
    const job = jobs.get(jobId);
    if (job === undefined) throw new Error(`no job ${jobId}`);
    job.settle(state);
  };
  const settleAll = () => { for (const job of jobs.values()) job.settle("cancelled"); };
  return { image, settle, settleAll };
}

function rig(options: { cancelSettles?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "gl-image-end-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = openThreadStore(path.join(dir, "threads.db"));
  const thread = store.createThread();
  const images = fakeImages(store, options.cancelSettles ?? true);
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    throw new Error(`no request leaves an Image mode turn: ${String(url)}`);
  });
  const log: Heard[] = [];
  const app = createApp({
    store, image: images.image,
    runtime: { status: () => READY, baseUrl: () => "http://fake", onChange: () => () => {}, ensure: async () => READY, lookIfDown: async () => READY },
    catalog: chatCatalog(),
    push: (channel, payload) => { log.push({ channel, payload }); },
    turnSaid: (s) => { log.push({ said: s }); },
    fit: { runNvidiaSmi: async (args) => (args[0]?.startsWith("--query-gpu") ? "16384, 1024, 15360\n" : ""), readMeminfo: async () => "MemAvailable: 32000000 kB\n" },
  });
  cleanups.push(async () => { images.settleAll(); await app.shutdown(); store.close(); });
  const draw = (extra: { drawCount?: number; retryOf?: string } = {}) =>
    sendTaken(app, { threadId: thread.id, content: "a lighthouse at dusk", model: "", numCtx: 4096, draw: DRAWN, ...extra }, { clientId: 1 });
  const saidAt = (turnId: string, type: string) => log.findIndex((h) => "said" in h && h.said.turnId === turnId && h.said.event.type === type);
  const toldAt = (id: string, ok: (c: ReplyChange) => boolean) => log.findIndex((h) => { const c = changeOf(h); return c !== undefined && (c.kind === "is" ? c.reply.id : c.id) === id && ok(c); });
  const lastEvent = (turnId: string): TurnEnd | undefined => {
    const said = log.findLast((h): h is { readonly said: TurnSaid } => "said" in h && h.said.turnId === turnId && (h.said.event.type === "done" || h.said.event.type === "error"));
    return said?.said.event as TurnEnd | undefined;
  };
  const rows = () => store.getThread(thread.id).messages.map((m) => [m.role, m.imageJob?.state]);
  return { app, store, thread, draw, saidAt, toldAt, lastEvent, rows, settle: images.settle };
}

describe("an Image mode turn's start and end, as the windows hear them", () => {
  it("the windows hear a picture is being drawn only after the chat has said its question went in", async () => {
    const r = rig();
    const { id, turnId, admission } = await r.draw();
    await admission;
    const start = r.saidAt(turnId, "start");
    expect(start).toBeGreaterThanOrEqual(0);
    const drawing = r.toldAt(id, (c) => c.kind === "is" && c.reply.stage === "drawing");
    expect(drawing, "the record shown as drawing").toBeGreaterThan(start);
  });

  it("the windows hear a picture turn has ended only after the chat's last event for it", async () => {
    const r = rig();
    const { id, turnId, admission } = await r.draw();
    await admission;
    r.settle("job-1", "done");
    const ended = () => r.toldAt(id, (c) => c.kind === "is" && c.reply.stage === "done");
    await until(() => r.saidAt(turnId, "done") >= 0 && ended() >= 0, "the picture's end, told");
    expect(ended()).toBeGreaterThan(r.saidAt(turnId, "done"));
  });

  it("deleting the question of a picture still being drawn takes its pictures with it", async () => {
    const r = rig();
    const { turnId, admission } = await r.draw({ drawCount: 2 });
    const question = await admission;
    expect(r.rows()).toEqual([["user", undefined], ["assistant", "queued"], ["assistant", "queued"]]);
    await r.app.handlers["messages.delete"]!({ threadId: r.thread.id, messageId: question.id }, { clientId: 1 });
    await until(() => r.app.activeTurns() === 0, "the turn's end");
    expect(r.rows()).toEqual([]);
    expect(r.lastEvent(turnId)).toMatchObject({ type: "error", code: "cancelled" });
  });

  it("a picture turn is stamped as ended when its last picture settles, not its first", async () => {
    const r = rig();
    const { turnId, admission } = await r.draw({ drawCount: 2 });
    await admission;
    r.settle("job-1", "done");
    await sleep(30);
    const lastSettled = Date.now();
    r.settle("job-2", "done");
    await until(() => r.lastEvent(turnId) !== undefined, "the turn's end");
    const end = r.lastEvent(turnId);
    expect(end).toMatchObject({ type: "done", ended: { reason: "done" } });
    expect(end?.ended?.at).toBeGreaterThanOrEqual(lastSettled);
  });

  it("a picture stopped and then deleted is stamped as ended at the Stop, not when its picture settles", async () => {
    const r = rig({ cancelSettles: false });
    const { turnId, admission } = await r.draw();
    const question = await admission;
    const before = Date.now();
    await r.app.handlers["reply.stop"]({ id: turnId }, { clientId: 1 });
    const after = Date.now();
    const deleting = r.app.handlers["messages.delete"]!({ threadId: r.thread.id, messageId: question.id }, { clientId: 1 });
    await sleep(30);
    r.settle("job-1", "cancelled");
    await deleting;
    const end = r.lastEvent(turnId);
    expect(end).toMatchObject({ type: "error", code: "cancelled", ended: { reason: "stopped" } });
    expect(end?.ended?.at).toBeGreaterThanOrEqual(before);
    expect(end?.ended?.at).toBeLessThanOrEqual(after);
  });
});

describe("Retry of an Image mode question", () => {
  it("a Retry after a failed picture replaces the question and the failed card", async () => {
    const r = rig();
    const question = r.store.appendMessage({ threadId: r.thread.id, role: "user", content: "a lighthouse at dusk" });
    r.store.saveImageJob({ jobId: "job-failed", threadId: r.thread.id, state: "error", choice: DRAWN, message: "ComfyUI stopped answering" }, "a lighthouse at dusk");
    expect(r.rows()).toEqual([["user", undefined], ["assistant", "error"]]);
    const { admission } = await r.draw({ retryOf: question.id });
    await admission;
    r.settle("job-1", "done");
    await until(() => r.app.activeTurns() === 0, "the Retry's end");
    expect(r.rows()).toEqual([["user", undefined], ["assistant", "done"]]);
  });
});
