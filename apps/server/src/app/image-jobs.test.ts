import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageChoice, ImageEvent } from "@gates-local/contracts";
import { createApp } from "../app.ts";
import { sendStarted } from "../chat/send-started.ts";
import { createGpuLease } from "../gpu/lease.ts";
import type { ImageModule } from "../image/module.ts";
import { openThreadStore, type ThreadStore } from "../threads/store.ts";
import { chatCatalog } from "../../test/send-rig.ts";
import type { TurnEvent } from "./turn.ts";

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DRAWN: ImageChoice = { preset: "flux2-klein-4b-pixel", width: 512, height: 512 };
const TOOL_CHOICE: ImageChoice = { preset: "flux2-klein-4b-pixel", width: 768, height: 768 };
const CTX = { clientId: 1 };
const READY = { state: "ready" as const, owner: "external" as const, baseUrl: "http://fake" };
const ndjson = (items: unknown[]) => new Response(items.map((i) => JSON.stringify(i)).join("\n") + "\n");
const hang = (signal: AbortSignal | null | undefined) => new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
const settle = () => new Promise((r) => setTimeout(r, 50));
const within = <T>(ms: number, p: Promise<T>, what: string): Promise<T> => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} did not end within ${ms} ms`)), ms))]);
const tracked = <T>(p: Promise<T>) => {
  const state = { done: false };
  const settled = p.finally(() => { state.done = true; });
  return { state, settled };
};

type Ending = "done" | "cancelled" | "error";
interface Job {
  readonly ended: Promise<void>;
  end(state: Ending, rest?: Partial<ImageEvent>): void;
}

function fakeImage(store: ThreadStore, options: { slowCancel: boolean; gated: boolean }) {
  const jobs = new Map<string, Job>();
  const gates: (() => void)[] = [];
  let n = 0;
  const generate = vi.fn(async (params: { prompt: string; threadId?: string; choice?: ImageChoice; group?: ImageEvent["group"]; seed?: number }) => {
    if (options.gated) await new Promise<void>((resolve) => gates.push(resolve));
    const jobId = `job-${++n}`;
    const card = (state: ImageEvent["state"], rest: Partial<ImageEvent> = {}) => store.saveImageJob({ jobId, ...(params.threadId ? { threadId: params.threadId } : {}), state, ...(params.choice ? { choice: params.choice } : {}), ...(params.group ? { group: params.group } : {}), ...rest }, params.prompt);
    card("queued");
    let finish!: () => void;
    const ended = new Promise<void>((resolve) => (finish = resolve));
    let over = false;
    jobs.set(jobId, {
      ended,
      end(state, rest = {}) {
        if (over) return;
        over = true;
        card(state, state === "done" ? { progress: 1, imagePath: `images/${jobId}.png`, ...rest } : rest);
        finish();
      },
    });
    return { jobId };
  });
  const cancel = vi.fn((jobId: string) => {
    const job = jobs.get(jobId);
    if (!options.slowCancel) job?.end("cancelled", { message: "The image was cancelled; try again when you are ready.", errorKind: "cancelled" });
    return { cancelled: job !== undefined };
  });
  const wait = async (jobId: string) => { await jobs.get(jobId)?.ended; };
  const image = { current: () => ({ state: "stopped", owner: "none" }), generate, cancel, wait } as unknown as ImageModule;
  const end = (jobId: string, state: Ending, rest?: Partial<ImageEvent>) => {
    const job = jobs.get(jobId);
    if (job === undefined) throw new Error(`no ${jobId}`);
    job.end(state, rest);
  };
  const endAll = () => { for (const id of jobs.keys()) end(id, "cancelled"); };
  const letGenerate = () => { for (const go of gates.splice(0)) go(); };
  return { image, generate, cancel, end, endAll, letGenerate, gated: () => gates.length };
}

async function rig(options: { slowCancel?: boolean; gated?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "gl-image-jobs-"));
  dirs.push(root);
  const store = openThreadStore(path.join(root, "threads.db"));
  const lease = createGpuLease();
  const acquire = vi.spyOn(lease, "acquire");
  const fake = fakeImage(store, { slowCancel: options.slowCancel ?? false, gated: options.gated ?? false });
  const requests: string[] = [];
  let chats = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const pathname = new URL(String(url)).pathname;
    requests.push(pathname);
    if (pathname === "/api/show") return Response.json({ capabilities: ["tools"] });
    if (pathname === "/api/ps") return Response.json({ models: [{ name: "m", model: "m", size: 1000, size_vram: 1000, context_length: 16384, expires_at: "later", digest: "d" }] });
    if (pathname === "/api/tags") return Response.json({ models: [] });
    if (pathname !== "/api/chat") throw new Error(`unexpected request ${pathname}`);
    chats += 1;
    if (chats === 1) return ndjson([{ message: { tool_calls: [{ function: { name: "image", arguments: { prompt: "a cat" } } }, { function: { name: "nothing", arguments: {} } }] }, done: true }]);
    return hang(init?.signal);
  }));
  const said: { turnId: string; event: TurnEvent }[] = [];
  const app = createApp({
    store, image: fake.image, lease, toolsEnabled: () => true, imageTool: () => TOOL_CHOICE,
    runtime: { status: () => READY, baseUrl: () => "http://fake", onChange: () => () => {}, ensure: async () => READY, lookIfDown: async () => READY },
    catalog: chatCatalog(),
    push: () => undefined,
    turnSaid: ({ turnId, event }) => { if (event.type !== "reply") said.push({ turnId, event }); },
    fit: { runNvidiaSmi: async (args) => args[0]?.startsWith("--query-gpu") ? "16384, 1024, 15360\n" : "", readMeminfo: async () => "MemAvailable: 32000000 kB\n" },
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    fake.letGenerate();
    fake.endAll();
    await app.shutdown();
    store.close();
  };
  closers.push(close);
  const thread = store.createThread();
  const draw = () => sendStarted(app, { threadId: thread.id, content: "a lighthouse at dusk", model: "m", numCtx: 16384, draw: DRAWN }, CTX);
  const chat = () => sendStarted(app, { threadId: thread.id, content: "draw me a cat", model: "m", numCtx: 16384 }, CTX);
  const generateFor = (threadId: string) => app.handlers["image.generate"]!({ prompt: "a tree", threadId }, CTX);
  const remove = (threadId: string) => Promise.resolve(app.handlers["threads.delete"]({ threadId }, CTX));
  const events = (turnId: string) => said.flatMap((s) => (s.turnId === turnId ? [s.event] : []));
  return { app, store, lease, acquire, fake, requests, chats: () => chats, thread, draw, chat, generateFor, remove, events, close };
}

describe("deleting a thread takes back its image jobs", () => {
  it("a picture that already finished is left alone; only the one still being made is cancelled", async () => {
    const t = await rig();
    const { jobId: finished } = await t.generateFor(t.thread.id);
    t.fake.end(finished, "done");
    await settle();
    const { jobId: running } = await t.generateFor(t.thread.id);
    expect(await within(3000, t.remove(t.thread.id), "threads.delete")).toEqual({ threadId: t.thread.id });
    expect(t.fake.cancel).toHaveBeenCalledWith(running);
    expect(t.fake.cancel).not.toHaveBeenCalledWith(finished);
  });

  it("the delete answers only once every picture it cancelled has ended, and the thread is kept until then", async () => {
    const t = await rig({ slowCancel: true });
    const { jobId: first } = await t.generateFor(t.thread.id);
    const { jobId: second } = await t.generateFor(t.thread.id);
    const deleting = tracked(t.remove(t.thread.id));
    await vi.waitFor(() => expect(t.fake.cancel.mock.calls.map(([id]) => id).toSorted()).toEqual([first, second]));
    await settle();
    expect(deleting.state.done).toBe(false);
    t.fake.end(first, "cancelled");
    await settle();
    expect(deleting.state.done).toBe(false);
    expect(t.store.getThread(t.thread.id).thread.id).toBe(t.thread.id);
    t.fake.end(second, "cancelled");
    expect(await within(3000, deleting.settled, "threads.delete")).toEqual({ threadId: t.thread.id });
    expect(() => t.store.getThread(t.thread.id)).toThrow(/thread/i);
  });

  it("a picture whose job is still being created when the delete starts is cancelled once it exists, before the delete answers", async () => {
    const t = await rig({ gated: true });
    const generating = t.generateFor(t.thread.id);
    await vi.waitFor(() => expect(t.fake.gated()).toBe(1));
    const deleting = tracked(t.remove(t.thread.id));
    await settle();
    expect(deleting.state.done).toBe(false);
    expect(t.fake.cancel).not.toHaveBeenCalled();
    t.fake.letGenerate();
    const { jobId } = await generating;
    expect(await within(3000, deleting.settled, "threads.delete")).toEqual({ threadId: t.thread.id });
    expect(t.fake.cancel).toHaveBeenCalledWith(jobId);
  });
});

describe("the image tool's job and the turn that queued it", () => {
  it("a Stop after the image tool has returned takes back the picture it queued", async () => {
    const t = await rig();
    const { turnId, ended } = await t.chat();
    await vi.waitFor(() => expect(t.chats()).toBe(2));
    expect(t.fake.generate).toHaveBeenCalledOnce();
    expect(t.fake.cancel).not.toHaveBeenCalled();
    expect(await t.app.handlers["reply.stop"]({ id: turnId }, CTX)).toMatchObject({ answer: "done" });
    await ended;
    expect(t.fake.cancel).toHaveBeenCalledWith("job-1");
    expect(t.store.getMessage("job-1")?.imageJob).toMatchObject({ state: "cancelled" });
  });

  it("deleting a thread while its reply still runs takes back the picture the reply already queued, and answers once that picture has ended", async () => {
    const t = await rig({ slowCancel: true });
    const { ended } = await t.chat();
    await vi.waitFor(() => expect(t.chats()).toBe(2));
    const deleting = tracked(t.remove(t.thread.id));
    await ended;
    expect(t.fake.cancel).toHaveBeenCalledWith("job-1");
    await settle();
    expect(deleting.state.done).toBe(false);
    t.fake.end("job-1", "cancelled");
    expect(await within(3000, deleting.settled, "threads.delete")).toEqual({ threadId: t.thread.id });
    expect(() => t.store.getThread(t.thread.id)).toThrow(/thread/i);
  });
});

describe("an Image mode turn", () => {
  it("deleting the thread while it draws cancels the picture, and the delete then finishes", async () => {
    const t = await rig();
    await t.draw();
    expect(t.app.activeTurns()).toBe(1);
    expect(await within(3000, t.remove(t.thread.id), "threads.delete")).toEqual({ threadId: t.thread.id });
    expect(t.fake.cancel).toHaveBeenCalledWith("job-1");
    expect(t.app.activeTurns()).toBe(0);
    expect(() => t.store.getThread(t.thread.id)).toThrow(/thread/i);
  });

  it("deleting its question while it draws cancels the picture and takes the card away with the question", async () => {
    const t = await rig();
    const { turnId, userMessage, ended } = await t.draw();
    expect(await within(3000, Promise.resolve(t.app.handlers["messages.delete"]!({ threadId: t.thread.id, messageId: userMessage.id }, CTX)), "messages.delete")).toEqual({ messageId: userMessage.id });
    expect(t.fake.cancel).toHaveBeenCalledWith("job-1");
    await ended;
    expect(t.store.getThread(t.thread.id).messages).toEqual([]);
    expect(t.events(turnId).at(-1)).toMatchObject({ type: "error", code: "cancelled" });
  });

  it("shutting down while it draws cancels the picture, and the shutdown then finishes", async () => {
    const t = await rig();
    await t.draw();
    await within(3000, t.app.shutdown(), "shutdown");
    expect(t.fake.cancel).toHaveBeenCalledWith("job-1");
    expect(t.app.activeTurns()).toBe(0);
  });

  it("holds no chat claim on the GPU while it draws", async () => {
    const t = await rig();
    const { turnId, ended } = await t.draw();
    await settle();
    expect(t.lease.status().holders).toBe(0);
    t.fake.end("job-1", "done");
    await ended;
    expect(t.acquire.mock.calls.map(([kind]) => kind)).not.toContain("chat");
    expect(t.events(turnId).at(-1)).toMatchObject({ type: "done" });
  });

  it("a picture that fails ends the turn with its card, and the card says why", async () => {
    const t = await rig();
    const { turnId, ended } = await t.draw();
    const why = "The picture needed more GPU memory than was free; try a smaller size.";
    t.fake.end("job-1", "error", { message: why, errorKind: "wont-fit" });
    await ended;
    expect(t.events(turnId).at(-1)).toMatchObject({ type: "done", message: { id: "job-1", imageJob: { state: "error", message: why } } });
    expect(t.store.getThread(t.thread.id).messages.at(-1)?.imageJob).toMatchObject({ state: "error", message: why });
  });

  it("is never counted as a chat model in GPU memory: asking which replies a send would stop names none and reads nothing from the runtime", async () => {
    const t = await rig();
    await t.draw();
    expect(t.app.activeTurns()).toBe(1);
    expect(await t.app.handlers["turns.blocking"]!({ model: "m", numCtx: 16384 }, CTX)).toEqual([]);
    expect(t.requests).toEqual([]);
  });
});
