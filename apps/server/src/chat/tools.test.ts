import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { streamToolTurn } from "./tools.ts";
import { createSources } from "../sources/index.ts";
import { createApp } from "../app.ts";
import { openThreadStore, type ThreadStore } from "../threads/store.ts";
import { createGpuLease, type GpuLease } from "../gpu/lease.ts";
import type { ImageModule } from "../image/module.ts";

const ndjson = (items: unknown[]) => new Response(items.map(i => JSON.stringify(i)).join("\n") + "\n");
/** No ComfyUI is up, so chat.send has nothing to free before its claim. */
const noComfy = () => ({ state: "stopped", owner: "none" });
/** An image module over the app's real lease, shaped like image/module.ts: generate returns the id at once and the job claims the GPU alone. */
const fakeImage = (lease: GpuLease, store: ThreadStore, gate?: Promise<void>) => {
  const jobs = new Map<string, AbortController>();
  const ended = new Map<string, Promise<void>>();
  const ran: string[] = [];
  let n = 0;
  const generate = vi.fn(async ({ prompt, threadId }: { prompt: string; threadId?: string }) => {
    await gate;
    const jobId = `job-${++n}`;
    const controller = new AbortController();
    jobs.set(jobId, controller);
    ended.set(jobId, lease.run("image", controller.signal, async () => {
      ran.push(jobId);
      if (threadId) store.appendMessage({ threadId, role: "assistant", content: prompt, images: [`images/${jobId}.png`] });
    }).catch(() => {}).finally(() => jobs.delete(jobId)));
    return { jobId };
  });
  const wait = async (jobId: string) => { await ended.get(jobId); };
  const cancel = vi.fn((jobId: string) => {
    const job = jobs.get(jobId);
    job?.abort(new Error("cancelled"));
    return { cancelled: job !== undefined };
  });
  return { image: { current: noComfy, generate, cancel, wait } as unknown as ImageModule, generate, cancel, ran };
};
/** A tool turn whose first reply calls the image tool; `second` answers the request after the tool ran. */
const imageApp = async (second: (signal: AbortSignal | undefined) => Response | Promise<Response>, gate?: Promise<void>) => {
  const root = mkdtempSync(path.join(tmpdir(), "gl-app-image-"));
  const sources = createSources({ dataDir: path.join(root, "data") });
  const file = path.join(root, "notes.txt"); writeFileSync(file, "hello");
  await sources.add({ kind: "file", path: file });
  const store = openThreadStore(path.join(root, "threads.db"));
  const lease = createGpuLease();
  const fake = fakeImage(lease, store, gate);
  const chatBodies: { tools?: { function: { name: string } }[] }[] = [];
  let atSecond: ReturnType<GpuLease["status"]> | undefined;
  const fetcher = vi.fn(async (url, init) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/api/show") return Response.json({ capabilities: ["tools"] });
    if (pathname === "/api/ps") return Response.json({ models: [{ name: "m", model: "m", size: 1000, size_vram: 1000, context_length: 16384, expires_at: "later", digest: "d" }] });
    if (pathname === "/api/tags") return Response.json({ models: [] });
    chatBodies.push(JSON.parse(String(init?.body)));
    if (chatBodies.length === 1) return ndjson([{ message: { tool_calls: [{ function: { name: "image", arguments: { prompt: "a cat" } } }] }, done: true }]);
    atSecond ??= lease.status();
    return second(init?.signal ?? undefined);
  });
  vi.stubGlobal("fetch", fetcher);
  const app = createApp({ store, sources, toolsEnabled: () => true, image: fake.image, lease,
    runtime: { status: () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }), baseUrl: () => "http://fake", onChange: () => () => {}, ensure: async () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }) },
    catalog: { current: () => [], refresh: async () => ({ models: [], changed: false }), onChange: () => () => {}, stop: () => {} },
    push: () => {}, fit: { runNvidiaSmi: async args => args[0]?.startsWith("--query-gpu") ? "16384, 1024, 15360\n" : "", readMeminfo: async () => "MemAvailable: 32000000 kB\n" },
  });
  return { app, store, lease, fake, chatBodies, atSecond: () => atSecond, close: async () => { await app.shutdown(); store.close(); vi.unstubAllGlobals(); } };
};
/** An Ollama reply that never comes; it rejects when the turn aborts the request. */
const hang = (signal: AbortSignal | undefined) => new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
describe("tool chat transport", () => {
  it("chooses native tool_calls from /api/show and carries think and num_ctx", async () => {
    const requests: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (url, init) => {
      if (String(url).endsWith("/api/show")) return Response.json({ capabilities: ["completion", "tools"] });
      requests.push(JSON.parse(String(init?.body)));
      return requests.length === 1 ? ndjson([{ message: { tool_calls: [{ function: { name: "read", arguments: { path: "/library/docs" } } }] }, done: true, done_reason: "stop" }]) : ndjson([{ message: { content: "All done" }, done: true, total_duration: 2_000_000_000, eval_duration: 250_000_000, prompt_eval_duration: 40_000_000, eval_count: 5 }]);
    });
    const events = [];
    for await (const e of streamToolTurn({ baseUrl: "http://fake", model: "qwen", messages: [{ role: "user", content: "read" }], numCtx: 16384, think: false, sources: [], fetch: fetcher, execute: async () => ({ output: "text", summary: "Read your file" }) })) events.push(e);
    expect(requests[0]).toMatchObject({ tools: expect.any(Array), think: false, options: { num_ctx: 16384 } });
    expect(events.at(-1)).toMatchObject({ type: "done", message: { content: "All done", tools: [{ state: "done" }] } });
    // Decode time rides through the tool loop separately from the wall time.
    expect(events.at(-1)).toMatchObject({ message: { stats: { durationMs: 2000, evalDurationMs: 250, promptEvalDurationMs: 40, completionTokens: 5 } } });
    expect(JSON.stringify(requests[1])).toContain('"role":"tool"');
  });
  it("uses text calls for gemma and refuses truncated native calls", async () => {
    for (const native of [true, false]) {
      const execute = vi.fn();
      const fetcher = vi.fn(async url => String(url).endsWith("/api/show") ? Response.json({ capabilities: native ? ["tools"] : ["completion"] }) : ndjson([{ message: native ? { tool_calls: [{ function: { name: "read", arguments: {} } }] } : { content: '<tool_call>{"name":"read","arguments":' }, done: true, done_reason: "length" }]));
      const events = [];
      for await (const e of streamToolTurn({ baseUrl: "http://fake", model: "m", messages: [], numCtx: 16384, sources: [], fetch: fetcher, execute })) events.push(e);
      expect(execute).not.toHaveBeenCalled();
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "length" });
      expect(events.filter(e => e.type === "tool")).toHaveLength(1);
    }
  });
  it("persists a chat.send tool step through app.ts with fake fetch and no listeners", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gl-app-tools-"));
    const sources = createSources({ dataDir: path.join(root, "data") });
    const file = path.join(root, "notes.txt"); writeFileSync(file, "hello library");
    const source = await sources.add({ kind: "file", path: file });
    const store = openThreadStore(path.join(root, "threads.db"));
    let chats = 0;
    const fetcher = vi.fn(async url => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/api/show") return Response.json({ capabilities: ["tools"] });
      if (pathname === "/api/ps") return Response.json({ models: [{ name: "m", model: "m", size: 1000, size_vram: 1000, context_length: 16384, expires_at: "later", digest: "d" }] });
      if (pathname === "/api/tags") return Response.json({ models: [] });
      return ++chats === 1 ? ndjson([{ message: { tool_calls: [{ function: { name: "read", arguments: { path: `/library/${source.id}` } } }] }, done: true }]) : ndjson([{ message: { content: "hello library" }, done: true }]);
    });
    vi.stubGlobal("fetch", fetcher);
    const pushed: unknown[] = [];
    const app = createApp({ store, sources, toolsEnabled: () => true,
      runtime: { status: () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }), baseUrl: () => "http://fake", onChange: () => () => {}, ensure: async () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }) },
      catalog: { current: () => [], refresh: async () => ({ models: [], changed: false }), onChange: () => () => {}, stop: () => {} },
      push: (channel, payload) => pushed.push({ channel, payload }),
      fit: { runNvidiaSmi: async args => args[0]?.startsWith("--query-gpu") ? "16384, 1024, 15360\n" : "", readMeminfo: async () => "MemAvailable: 32000000 kB\n" },
    });
    try {
      const thread = await app.handlers["threads.create"]({ title: "tools" }, { clientId: 1 });
      await app.handlers["chat.send"]({ threadId: thread.id, content: "read", model: "m", numCtx: 16384 }, { clientId: 1 });
      await vi.waitFor(() => expect(app.activeTurns()).toBe(0));
      expect(store.getThread(thread.id).messages.at(-1)).toMatchObject({ role: "assistant", content: "hello library", tools: [{ name: "read", state: "done" }] });
      expect(JSON.stringify(pushed)).toContain('"state":"running"');
    } finally { await app.shutdown(); store.close(); vi.unstubAllGlobals(); }
  });
  for (const image of [true, undefined]) {
    it(`chat.send ${image ? "offers the image tool and queues the job, which runs after the reply" : "neither offers nor runs the image tool"} when image is ${image}`, async () => {
      const t = await imageApp(() => ndjson([{ message: { content: "done" }, done: true }]));
      try {
        const thread = t.store.createThread();
        await t.app.handlers["chat.send"]({ threadId: thread.id, content: "draw", model: "m", numCtx: 16384, ...(image ? { image } : {}) }, { clientId: 1 });
        // The turn holds a shared GPU claim to its end; a tool that waited for the picture would never get here.
        await vi.waitFor(() => expect(t.app.activeTurns()).toBe(0));
        const offered = t.chatBodies[0]!.tools!.map(tool => tool.function.name);
        if (image) {
          expect(offered).toContain("image");
          expect(t.fake.generate).toHaveBeenCalledWith({ prompt: "a cat", threadId: thread.id });
          // While the reply streamed, the job waited for the GPU instead of running beside it.
          expect(t.atSecond()).toMatchObject({ holder: "chat", waiting: ["image"] });
          await vi.waitFor(() => expect(t.fake.ran).toEqual(["job-1"]));
          const messages = t.store.getThread(thread.id).messages;
          expect(messages.map(m => [m.role, m.content])).toEqual([["user", "draw"], ["assistant", "done"], ["assistant", "a cat"]]);
          expect(messages[1]).toMatchObject({ tools: [{ name: "image", state: "done", summary: "Queued an image" }] });
          expect(messages[1]).not.toHaveProperty("images");
          expect(messages[2]).toMatchObject({ images: ["images/job-1.png"] });
          expect(t.lease.status()).toEqual({ holder: null, holders: 0, waiting: [] });
        } else {
          expect(offered).not.toContain("image");
          expect(t.fake.generate).not.toHaveBeenCalled();
          expect(t.store.getThread(thread.id).messages.at(-1)).toMatchObject({ tools: [{ name: "image", state: "error" }] });
        }
      } finally { await t.close(); }
    });
  }
  for (const when of ["while the reply streams", "while the job is being queued"] as const) {
    it(`a turn cancelled ${when} takes back the image it queued`, async () => {
      let open!: () => void;
      const gate = when === "while the job is being queued" ? new Promise<void>(r => (open = r)) : undefined;
      const t = await imageApp(hang, gate);
      try {
        const thread = t.store.createThread();
        const { turnId } = await t.app.handlers["chat.send"]({ threadId: thread.id, content: "draw", model: "m", numCtx: 16384, image: true }, { clientId: 1 });
        if (gate) await vi.waitFor(() => expect(t.fake.generate).toHaveBeenCalledTimes(1));
        else await vi.waitFor(() => expect(t.chatBodies).toHaveLength(2));
        expect(await t.app.handlers["chat.cancel"]({ turnId }, { clientId: 1 })).toEqual({ cancelled: true });
        open?.();
        await vi.waitFor(() => expect(t.app.activeTurns()).toBe(0));
        await vi.waitFor(() => expect(t.lease.status()).toEqual({ holder: null, holders: 0, waiting: [] }));
        expect(t.fake.cancel).toHaveBeenCalledWith("job-1");
        expect(t.fake.ran).toEqual([]);
        expect(t.store.getThread(thread.id).messages.map(m => m.role)).toEqual(["user"]);
      } finally { await t.close(); }
    });
  }
  for (const scenario of ["tools explicitly off", "tools default off", "empty Library"] as const) {
    it(`keeps the original plain turn for ${scenario}`, async () => {
      const root = mkdtempSync(path.join(tmpdir(), "gl-plain-tools-"));
      const sources = createSources({ dataDir: path.join(root, "data") });
      if (scenario !== "empty Library") {
        const file = path.join(root, "note.txt"); writeFileSync(file, "note");
        await sources.add({ kind: "file", path: file });
      }
      const store = openThreadStore(path.join(root, "threads.db"));
      const chatBodies: unknown[] = [];
      const fetcher = vi.fn(async (url, init) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === "/api/ps") return Response.json({ models: [{ name: "m", model: "m", size: 1000, size_vram: 1000, context_length: 16384, expires_at: "later", digest: "d" }] });
        if (pathname === "/api/tags") return Response.json({ models: [] });
        if (pathname !== "/api/chat") throw new Error(`Plain chat must not request ${pathname}`);
        chatBodies.push(JSON.parse(String(init?.body)));
        return ndjson([{ message: { content: "plain reply" }, done: true }]);
      });
      vi.stubGlobal("fetch", fetcher);
      const app = createApp({ store, sources, think: true, toolsEnabled: () => scenario !== "tools default off",
        runtime: { status: () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }), baseUrl: () => "http://fake", onChange: () => () => {}, ensure: async () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }) },
        catalog: { current: () => [], refresh: async () => ({ models: [], changed: false }), onChange: () => () => {}, stop: () => {} },
        push: () => {}, fit: { runNvidiaSmi: async args => args[0]?.startsWith("--query-gpu") ? "16384, 1024, 15360\n" : "", readMeminfo: async () => "MemAvailable: 32000000 kB\n" },
      });
      try {
        const thread = store.createThread();
        await app.handlers["chat.send"]({ threadId: thread.id, content: "hello", model: "m", numCtx: 16384, think: false, ...(scenario === "tools explicitly off" ? { tools: false } : scenario === "empty Library" ? { tools: true } : {}) }, { clientId: 1 });
        await vi.waitFor(() => expect(app.activeTurns()).toBe(0));
        expect(store.getThread(thread.id).messages.at(-1)).toMatchObject({ role: "assistant", content: "plain reply" });
        expect(chatBodies).toEqual([{ model: "m", messages: [{ role: "user", content: "hello" }], stream: true, think: false, options: { num_ctx: 16384 } }]);
      } finally { await app.shutdown(); store.close(); vi.unstubAllGlobals(); }
    });
  }
});
