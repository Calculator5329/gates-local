// Image mode (chat.send draw) and Tools › Make images (the imageTool dep), over a fake Ollama
// and an image module shaped like image/module.ts: generate saves the card at once and the
// job claims the GPU alone.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageChoice, ImageEvent } from "@gates-local/contracts";
import { createApp } from "../app.ts";
import { sendStarted } from "./send-started.ts";
import { createGpuLease } from "../gpu/lease.ts";
import type { ImageModule } from "../image/module.ts";
import { createSources } from "../sources/index.ts";
import { openThreadStore } from "../threads/store.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CHOSEN: ImageChoice = { preset: "moss-image", width: 1024, height: 1024 };
const DRAWN: ImageChoice = { preset: "flux2-klein-4b-pixel", width: 512, height: 512 };
const ndjson = (items: unknown[]) => new Response(items.map((i) => JSON.stringify(i)).join("\n") + "\n");

async function rig(options: { imageTool?: ImageChoice; hold?: boolean; firstDone?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "gl-image-mode-"));
  dirs.push(root);
  const sources = createSources({ dataDir: path.join(root, "data") });
  const file = path.join(root, "notes.txt");
  writeFileSync(file, "hello");
  await sources.add({ kind: "file", path: file });
  const store = openThreadStore(path.join(root, "threads.db"));
  const lease = createGpuLease();
  const jobs = new Map<string, { controller: AbortController; ended: Promise<void> }>();
  let n = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const generate = vi.fn(async (params: { prompt: string; threadId?: string; choice?: ImageChoice; group?: ImageEvent["group"]; seed?: number }) => {
    const jobId = `job-${++n}`;
    const controller = new AbortController();
    const card = (state: ImageEvent["state"], rest: Partial<ImageEvent> = {}) => store.saveImageJob({ jobId, ...(params.threadId ? { threadId: params.threadId } : {}), state, ...(params.choice ? { choice: params.choice } : {}), ...(params.group ? { group: params.group } : {}), ...rest }, params.prompt);
    card("queued");
    const ended = lease.run("image", controller.signal, async () => {
      if (options.hold && !(options.firstDone && jobId === "job-1")) await new Promise<void>((resolve, reject) => { void held.then(resolve); controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }); });
      card("done", { progress: 1, imagePath: `images/${jobId}.png` });
    }).catch(() => card("cancelled", { message: "The image was cancelled; try again when you are ready.", errorKind: "cancelled" }));
    jobs.set(jobId, { controller, ended });
    return { jobId };
  });
  const cancel = vi.fn((jobId: string) => {
    const job = jobs.get(jobId);
    job?.controller.abort(new Error("cancelled"));
    return { cancelled: job !== undefined };
  });
  const image = { current: () => ({ state: "stopped", owner: "none" }), generate, cancel, wait: async (jobId: string) => { await jobs.get(jobId)?.ended; } } as unknown as ImageModule;
  const requests: string[] = [];
  const chatBodies: { tools?: { function: { name: string } }[] }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const pathname = new URL(String(url)).pathname;
    requests.push(pathname);
    if (pathname === "/api/show") return Response.json({ capabilities: ["tools"] });
    if (pathname === "/api/ps") return Response.json({ models: [{ name: "m", model: "m", size: 1000, size_vram: 1000, context_length: 16384, expires_at: "later", digest: "d" }] });
    if (pathname === "/api/tags") return Response.json({ models: [] });
    chatBodies.push(JSON.parse(String(init?.body)));
    if (chatBodies.length === 1) return ndjson([{ message: { tool_calls: [{ function: { name: "image", arguments: { prompt: "a cat" } } }] }, done: true }]);
    return ndjson([{ message: { content: "done" }, done: true }]);
  }));
  const events: { type: string }[] = [];
  const changed: string[] = [];
  const ready ={ state: "ready" as const, owner: "external" as const, baseUrl: "http://fake" };
  const app = createApp({
    store, sources, image, lease, toolsEnabled: () => true, imageTool: () => options.imageTool,
    runtime: { status: () => ready, baseUrl: () => "http://fake", onChange: () => () => {}, ensure: async () => ready, lookIfDown: async () => ready },
    catalog: { current: () => [], refresh: async () => ({ models: [], changed: false }), onChange: () => () => {}, stop: () => {} },
    push: (channel, payload) => {
      // the turn's events; its reply records (decision 33) are not what these cases read
      if (channel === "chat.event" && (payload as { event: { type: string } }).event.type !== "reply") events.push((payload as { event: { type: string } }).event);
      if (channel === "threads.changed") changed.push((payload as { threadId: string }).threadId);
    },
    fit: { runNvidiaSmi: async (args) => args[0]?.startsWith("--query-gpu") ? "16384, 1024, 15360\n" : "", readMeminfo: async () => "MemAvailable: 32000000 kB\n" },
  });
  const thread = store.createThread();
  const send = (extra: Record<string, unknown> = {}) => sendStarted(app, { threadId: thread.id, content: "a lighthouse at dusk", model: "m", numCtx: 16384, ...extra }, { clientId: 1 });
  return { app, store, lease, thread, send, generate, cancel, requests, chatBodies, events, changed, release, close: async () => { await app.shutdown(); store.close(); } };
}

describe("Tools › Make images decides whether a chat model is offered the image tool", () => {
  it("off: the chat request offers no image tool, and an old client's image: true does not turn it on", async () => {
    const t = await rig();
    try {
      await t.send({ image: true });
      await vi.waitFor(() => expect(t.app.activeTurns()).toBe(0));
      const offered = t.chatBodies[0]!.tools!.map((tool) => tool.function.name);
      expect(offered).toContain("read");
      expect(offered).not.toContain("image");
      expect(t.generate).not.toHaveBeenCalled();
    } finally { await t.close(); }
  });

  it("on: the chat request offers the image tool, and the model's call starts one job with the app's chosen preset and size", async () => {
    const t = await rig({ imageTool: CHOSEN });
    try {
      await t.send();
      await vi.waitFor(() => expect(t.app.activeTurns()).toBe(0));
      expect(t.chatBodies[0]!.tools!.map((tool) => tool.function.name)).toContain("image");
      expect(t.generate).toHaveBeenCalledOnce();
      expect(t.generate).toHaveBeenCalledWith({ prompt: "a cat", threadId: t.thread.id, choice: CHOSEN });
    } finally { await t.close(); }
  });

  it("on, in a thread with its own image choice: the tool's job runs that one, not the app's last pick", async () => {
    const t = await rig({ imageTool: CHOSEN });
    try {
      t.store.setImageChoice(t.thread.id, DRAWN);
      await t.send();
      await vi.waitFor(() => expect(t.app.activeTurns()).toBe(0));
      expect(t.generate).toHaveBeenCalledWith({ prompt: "a cat", threadId: t.thread.id, choice: DRAWN });
    } finally { await t.close(); }
  });
});

describe("threads.setImageChoice", () => {
  it("keeps the pick on that thread only, tells clients, and refuses an unknown thread", async () => {
    const t = await rig();
    try {
      const other = t.store.createThread();
      expect(await t.app.handlers["threads.setImageChoice"]!({ threadId: t.thread.id, choice: DRAWN }, { clientId: 1 })).toMatchObject({ id: t.thread.id, imageChoice: DRAWN });
      expect(t.store.imageChoiceOf(t.thread.id)).toEqual(DRAWN);
      expect(t.store.imageChoiceOf(other.id)).toBeUndefined();
      expect(t.changed).toEqual([t.thread.id]);
      expect(() => t.app.handlers["threads.setImageChoice"]!({ threadId: "00000000-0000-4000-8000-000000000000", choice: DRAWN }, { clientId: 1 })).toThrow(/thread/i);
    } finally { await t.close(); }
  });
});

describe("Image mode: the typed words go straight to the image model", () => {
  for (const imageTool of [undefined, CHOSEN]) {
    it(`asks no chat model and starts one job with the words, preset and size (Tools setting ${imageTool ? "on" : "off"})`, async () => {
      const t = await rig(imageTool ? { imageTool } : {});
      try {
        const sent = await t.send({ draw: DRAWN });
        expect(sent.userMessage).toMatchObject({ role: "user", content: "a lighthouse at dusk" });
        await vi.waitFor(() => expect(t.app.activeTurns()).toBe(0));
        expect(t.requests).toEqual([]);
        expect(t.generate).toHaveBeenCalledOnce();
        expect(t.generate).toHaveBeenCalledWith({ prompt: "a lighthouse at dusk", threadId: t.thread.id, choice: DRAWN });
        const messages = t.store.getThread(t.thread.id).messages;
        expect(messages.map((m) => [m.role, m.content])).toEqual([["user", "a lighthouse at dusk"], ["assistant", "a lighthouse at dusk"]]);
        expect(messages[1]!.imageJob).toMatchObject({ state: "done", choice: DRAWN });
        // A chat turn's parts never appear: one start, then the card as the done message.
        expect(t.events.map((e) => e.type)).toEqual(["start", "done"]);
        expect(t.events[0]).toMatchObject({ type: "start", image: true, userMessage: { id: sent.userMessage.id } });
        expect(t.events[1]).toMatchObject({ type: "done", message: { id: messages[1]!.id, imageJob: { state: "done" } } });
      } finally { await t.close(); }
    });
  }

  it("is a running turn until the image ends: a second send waits its turn, and Stop cancels the job", async () => {
    const t = await rig({ hold: true });
    try {
      const { turnId } = await t.send({ draw: DRAWN });
      expect(await t.app.handlers["turns.active"]!({}, { clientId: 1 })).toEqual([{ turnId, threadId: t.thread.id, reply: expect.objectContaining({ attempt: 1 }) }]);
      await expect(t.send({ draw: DRAWN })).rejects.toMatchObject({ code: "turn-active" });
      expect(await t.app.handlers["chat.cancel"]({ turnId }, { clientId: 1 })).toEqual({ cancelled: true });
      await vi.waitFor(() => expect(t.app.activeTurns()).toBe(0));
      expect(t.cancel).toHaveBeenCalledWith("job-1");
      expect(t.store.getThread(t.thread.id).messages.at(-1)!.imageJob).toMatchObject({ state: "cancelled" });
      expect(t.events.at(-1)).toMatchObject({ type: "done", message: { imageJob: { state: "cancelled" } } });
      expect(t.requests).toEqual([]);
    } finally { t.release(); await t.close(); }
  });

  it("an edited prompt sent again is a new turn with its own picture; the first stays", async () => {
    const t = await rig();
    try {
      await t.send({ draw: DRAWN });
      await vi.waitFor(() => expect(t.app.activeTurns()).toBe(0));
      await sendStarted(t.app, { threadId: t.thread.id, content: "a lighthouse at dawn", model: "m", numCtx: 16384, draw: DRAWN }, { clientId: 1 });
      await vi.waitFor(() => expect(t.app.activeTurns()).toBe(0));
      expect(t.store.getThread(t.thread.id).messages.map((m) => [m.role, m.content, m.imageJob?.state])).toEqual([
        ["user", "a lighthouse at dusk", undefined], ["assistant", "a lighthouse at dusk", "done"],
        ["user", "a lighthouse at dawn", undefined], ["assistant", "a lighthouse at dawn", "done"],
      ]);
      expect(t.requests).toEqual([]);
    } finally { await t.close(); }
  });

  it("Retry after a cancelled picture replaces the question and the card", async () => {
    const t = await rig({ hold: true });
    try {
      const first = await t.send({ draw: DRAWN });
      await t.app.handlers["chat.cancel"]({ turnId: first.turnId }, { clientId: 1 });
      await vi.waitFor(() => expect(t.app.activeTurns()).toBe(0));
      t.release();
      await t.send({ draw: DRAWN, retryOf: first.userMessage.id });
      await vi.waitFor(() => expect(t.app.activeTurns()).toBe(0));
      expect(t.store.getThread(t.thread.id).messages.map((m) => [m.role, m.imageJob?.state])).toEqual([["user", undefined], ["assistant", "done"]]);
    } finally { await t.close(); }
  });

  it("a count of 3: three jobs one after another, seeds one apart, one group; the thread keeps 3, and Stop keeps the finished picture", async () => {
    const t = await rig({ hold: true, firstDone: true });
    try {
      const { turnId } = await t.send({ draw: DRAWN, drawCount: 3 });
      expect(t.generate).toHaveBeenCalledTimes(3);
      const sent = t.generate.mock.calls.map(([p]) => ({ group: p.group!, seed: p.seed! }));
      expect(sent.map((p) => [p.group.index, p.group.of])).toEqual([[0, 3], [1, 3], [2, 3]]);
      expect(new Set(sent.map((p) => p.group.id)).size).toBe(1);
      expect(sent.map((p) => (p.seed - sent[0]!.seed + 2 ** 32) % 2 ** 32)).toEqual([0, 1, 2]);
      expect(t.store.getThread(t.thread.id).thread.imageCount).toBe(3);
      await vi.waitFor(() => expect(t.store.getMessage("job-1")?.imageJob?.state).toBe("done"));
      await t.app.handlers["chat.cancel"]({ turnId }, { clientId: 1 });
      await vi.waitFor(() => expect(t.app.activeTurns()).toBe(0));
      expect(t.store.getThread(t.thread.id).messages.map((m) => m.imageJob?.state)).toEqual([undefined, "done", "cancelled", "cancelled"]);
      // the thread's next send makes three again without saying so
      t.release();
      await t.send({ draw: DRAWN, content: "again" });
      await vi.waitFor(() => expect(t.app.activeTurns()).toBe(0));
      expect(t.generate).toHaveBeenCalledTimes(6);
    } finally { t.release(); await t.close(); }
  });

  it("refuses attachments and keeps nothing", async () => {
    const t = await rig();
    try {
      await expect(t.send({ draw: DRAWN, images: ["data:image/png;base64,iVBORw0KGgo="] })).rejects.toMatchObject({ code: "image-input" });
      expect(t.store.getThread(t.thread.id).messages).toEqual([]);
      expect(t.generate).not.toHaveBeenCalled();
      expect(t.app.activeTurns()).toBe(0);
    } finally { await t.close(); }
  });

  it("a job that cannot be queued takes the question back with it", async () => {
    const t = await rig();
    try {
      t.generate.mockRejectedValueOnce(Object.assign(new Error("There is no image preset nope."), { code: "image-model" }));
      await expect(t.send({ draw: { preset: "nope", width: 1, height: 1 } })).rejects.toMatchObject({ code: "image-model" });
      expect(t.store.getThread(t.thread.id).messages).toEqual([]);
      expect(t.app.activeTurns()).toBe(0);
    } finally { await t.close(); }
  });
});
