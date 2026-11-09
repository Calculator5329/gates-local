import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as toolTransport from "./tools.ts";
import { estimateTokens, OMITTED_IMAGE } from "./window.ts";
import { createSources } from "../sources/index.ts";
import { createApp } from "../app.ts";
import { openThreadStore, type ThreadStore } from "../threads/store.ts";
import { createGpuLease, type GpuLease } from "../gpu/lease.ts";
import type { ImageModule } from "../image/module.ts";
const { streamToolTurn } = toolTransport;

const dirs: string[] = [];
const scratch = (prefix: string) => {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(root);
  return root;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const sentMessages = (bodies: Record<string, unknown>[]) => (bodies[0]?.["messages"] ?? []) as { role: string; content: string }[];

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
  const root = scratch("gl-app-image-");
  const sources = createSources({ dataDir: path.join(root, "data") });
  const file = path.join(root, "notes.txt"); writeFileSync(file, "hello");
  await sources.add({ kind: "file", path: file });
  const store = openThreadStore(path.join(root, "threads.db"));
  const lease = createGpuLease();
  const fake = fakeImage(lease, store, gate);
  const chatBodies: { tools?: { function: { name: string } }[] }[] = [];
  const pushed: unknown[] = [];
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
    push: (channel, payload) => pushed.push({ channel, payload }), fit: { runNvidiaSmi: async args => args[0]?.startsWith("--query-gpu") ? "16384, 1024, 15360\n" : "", readMeminfo: async () => "MemAvailable: 32000000 kB\n" },
  });
  return { app, store, lease, fake, chatBodies, pushed, atSecond: () => atSecond, close: async () => { await app.shutdown(); store.close(); vi.unstubAllGlobals(); } };
};
/** An Ollama reply that never comes; it rejects when the turn aborts the request. */
const hang = (signal: AbortSignal | undefined) => new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
/** The system prompt a tool turn sends for one SQLite and one folder source on this platform. */
const system = async (platform: NodeJS.Platform) => {
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  const fetcher = vi.fn(async (url, init) => {
    if (String(url).endsWith("/api/show")) return Response.json({ capabilities: ["tools"] });
    bodies.push(JSON.parse(String(init?.body)));
    return ndjson([{ message: { content: "ok" }, done: true }]);
  });
  const sources = [{ id: "books", label: "books.db", path: "live", snapshotPath: "snap", kind: "sqlite" as const }, { id: "notes", label: "Notes", path: "folder", kind: "folder" as const }];
  for await (const _ of streamToolTurn({ baseUrl: "http://fake", model: "qwen", messages: [], numCtx: 16384, sources, platform, fetch: fetcher, execute: async () => ({ output: "", summary: "" }) })) { /* drain */ }
  return bodies[0]!.messages[0]!.content;
};
describe("tool chat transport", () => {
  it("does not treat a quoted marker in ordinary text as a dropped image", async () => {
    const bodies: Record<string, unknown>[] = [];
    const omitted = vi.fn();
    const events = [];
    for await (const event of streamToolTurn({ baseUrl: "http://fake", model: "m", messages: [{ role: "user", content: `Explain this text: ${OMITTED_IMAGE}` }], numCtx: 16384, sources: [], fetch: answering(bodies), execute: noRun, onImageOmitted: omitted })) events.push(event);
    expect(omitted).not.toHaveBeenCalled();
    expect(events.at(-1)).not.toHaveProperty("message.contextNotice");
  });

  it("reports images dropped in a later round even when the reply then fails", async () => {
    const bodies: Record<string, unknown>[] = [];
    const omitted = vi.fn();
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/show")) return Response.json({ capabilities: ["tools"] });
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length > 1) throw new Error("synthetic interrupted reply");
      return ndjson([{ message: { tool_calls: [{ function: { name: "read", arguments: { path: "/library/docs" } } }] }, done: true }]);
    });
    const events = [];
    for await (const event of streamToolTurn({ baseUrl: "http://fake", model: "m", messages: [{ role: "user", content: "old chart", images: ["aW1hZ2U="], imageTokens: [4096] }, { role: "assistant", content: "a".repeat(2000) }, { role: "user", content: "read it" }], numCtx: 8192, sources: [], fetch: fetcher, execute: async () => ({ output: "z".repeat(10000), summary: "Read" }), onImageOmitted: omitted })) events.push(event);
    expect(JSON.stringify(bodies[0])).toContain('"images"');
    expect(JSON.stringify(bodies[1])).toContain("image was here and is unavailable");
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(omitted).toHaveBeenCalledOnce();
  });

  it("keeps a later image-omission notice on a stopped reply's terminal event", async () => {
    let markReady: (() => void) | undefined;
    const ready = new Promise<void>(resolve => { markReady = resolve; });
    const stream = vi.spyOn(toolTransport, "streamToolTurn").mockImplementation(async function* (input) {
      input.onImageOmitted?.();
      yield { type: "delta", text: "Partial answer" } as const;
      markReady?.();
      await new Promise<void>(resolve => {
        if (input.signal?.aborted) resolve();
        else input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "error", code: "cancelled", message: "stopped" } as const;
    });
    const t = await imageApp(() => ndjson([{ message: { content: "unused" }, done: true }]));
    try {
      const thread = t.store.createThread();
      const { turnId } = await t.app.handlers["chat.send"]({ threadId: thread.id, content: "read", model: "m", numCtx: 16384 }, { clientId: 1 });
      await ready;
      await t.app.handlers["chat.cancel"]({ turnId }, { clientId: 1 });
      await vi.waitFor(() => expect(t.app.activeTurns()).toBe(0));
      expect(t.pushed).toContainEqual(expect.objectContaining({ channel: "chat.event", payload: expect.objectContaining({ event: expect.objectContaining({ type: "delta", text: "", contextNotice: expect.stringContaining("images are unavailable") }) }) }));
      expect(t.pushed).toContainEqual(expect.objectContaining({ channel: "chat.event", payload: expect.objectContaining({ event: expect.objectContaining({ type: "error", contextNotice: expect.stringContaining("images are unavailable") }) }) }));
      expect(t.store.getThread(thread.id).messages.map(message => message.content)).toEqual(["read"]);
    } finally { await t.close(); stream.mockRestore(); }
  });

  it("chooses native tool_calls from /api/show and carries think and num_ctx", async () => {
    const requests: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (url, init) => {
      if (String(url).endsWith("/api/show")) return Response.json({ capabilities: ["completion", "tools"] });
      requests.push(JSON.parse(String(init?.body)));
      return requests.length === 1 ? ndjson([{ message: { tool_calls: [{ function: { name: "read", arguments: { path: "/library/docs" } } }] }, done: true, done_reason: "stop" }]) : ndjson([{ message: { content: "All done" }, done: true, total_duration: 2_000_000_000, eval_duration: 250_000_000, prompt_eval_duration: 40_000_000, eval_count: 5 }]);
    });
    const events = [];
    for await (const e of streamToolTurn({ baseUrl: "http://fake", model: "qwen", messages: [{ role: "user", content: "read", images: ["aW1hZ2U="] }], numCtx: 16384, think: false, sources: [], fetch: fetcher, execute: async () => ({ output: "text", summary: "Read your file" }) })) events.push(e);
    expect(requests[0]).toMatchObject({ tools: expect.any(Array), think: false, options: { num_ctx: 16384 } });
    expect(events.at(-1)).toMatchObject({ type: "done", message: { content: "All done", tools: [{ state: "done" }] } });
    // Decode time rides through the tool loop separately from the wall time.
    expect(events.at(-1)).toMatchObject({ message: { stats: { durationMs: 2000, evalDurationMs: 250, promptEvalDurationMs: 40, completionTokens: 5 } } });
    expect(JSON.stringify(requests[1])).toContain('"role":"tool"');
    for (const request of requests) expect(request["messages"]).toContainEqual({ role: "user", content: "read", images: ["aW1hZ2U="] });
  });
  it("the stall guard aborts a hung /api/chat request through its fetch signal", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let chatSignal: AbortSignal | undefined;
      const fetcher = vi.fn(async (url, init) => {
        if (String(url).endsWith("/api/show")) return Response.json({ capabilities: ["tools"] });
        chatSignal = init?.signal ?? undefined;
        return hang(chatSignal);
      });
      const run = (async () => {
        const events = [];
        for await (const e of streamToolTurn({ baseUrl: "http://fake", model: "qwen", messages: [{ role: "user", content: "hi" }], numCtx: 16384, sources: [], fetch: fetcher })) events.push(e);
        return events;
      })();
      await vi.advanceTimersByTimeAsync(120_000 + 1); // the default stall guard, STREAM_STALL_MS
      expect(chatSignal?.aborted).toBe(true);
      expect((await run).at(-1)).toMatchObject({ type: "error", code: "stream-error", message: "The model stopped sending for 120 s; the reply was stopped." });
    } finally { vi.useRealTimers(); }
  });
  it("names a SQLite source the way the offered tool takes it: a source id for sql on Windows, a /data path for the shell on Linux", async () => {
    const windows = await system("win32");
    expect(windows).not.toContain("/data/");
    expect(windows).toContain('books: books.db (sqlite): use sql with source "books"');
    expect(windows).toContain("notes: Notes (folder) at /library/notes");
    expect(await system("linux")).toContain("books: books.db (sqlite) at /data/books.db");
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
    const root = scratch("gl-app-tools-");
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
      const t = await imageApp(() => ndjson([{ message: { content: "Here's an image: ![Star Trek Ship](https://example.com/invented.png)" }, done: true }]));
      try {
        const thread = t.store.createThread();
        await t.app.handlers["chat.send"]({ threadId: thread.id, content: "draw", model: "m", numCtx: 16384, ...(image ? { image } : {}) }, { clientId: 1 });
        // The turn holds a shared GPU claim to its end; a tool that waited for the picture would never get here.
        await vi.waitFor(() => expect(t.app.activeTurns()).toBe(0));
        const offered = t.chatBodies[0]!.tools!.map(tool => tool.function.name);
        if (image) {
          expect(offered).toContain("image");
          expect(t.fake.generate).toHaveBeenCalledWith({ prompt: "a cat", threadId: thread.id });
          expect(t.chatBodies).toHaveLength(1);
          expect(t.atSecond()).toBeUndefined();
          await vi.waitFor(() => expect(t.fake.ran).toEqual(["job-1"]));
          const messages = t.store.getThread(thread.id).messages;
          expect(messages.map(m => [m.role, m.content])).toEqual([["user", "draw"], ["assistant", ""], ["assistant", "a cat"]]);
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
    it("a turn cancelled while the job is being queued takes back the image it queued", async () => {
      let open!: () => void;
      const gate = new Promise<void>(r => (open = r));
      const t = await imageApp(hang, gate);
      try {
        const thread = t.store.createThread();
        const { turnId } = await t.app.handlers["chat.send"]({ threadId: thread.id, content: "draw", model: "m", numCtx: 16384, image: true }, { clientId: 1 });
        await vi.waitFor(() => expect(t.fake.generate).toHaveBeenCalledTimes(1));
        expect(await t.app.handlers["chat.cancel"]({ turnId }, { clientId: 1 })).toEqual({ cancelled: true });
        open?.();
        await vi.waitFor(() => expect(t.app.activeTurns()).toBe(0));
        await vi.waitFor(() => expect(t.lease.status()).toEqual({ holder: null, holders: 0, waiting: [] }));
        expect(t.fake.cancel).toHaveBeenCalledWith("job-1");
        expect(t.fake.ran).toEqual([]);
        expect(t.store.getThread(thread.id).messages.map(m => m.role)).toEqual(["user"]);
      } finally { await t.close(); }
    });
  for (const scenario of ["tools explicitly off", "tools default off", "empty Library"] as const) {
    it(`keeps the original plain turn for ${scenario}`, async () => {
      const root = scratch("gl-plain-tools-");
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

const answering = (bodies: Record<string, unknown>[]) => vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url).endsWith("/api/show")) return Response.json({ capabilities: ["completion", "tools"] });
  bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
  return ndjson([{ message: { content: "ok" }, done: true, done_reason: "stop" }]);
});
const noRun = async () => ({ output: "", summary: "" });
const manySources = Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, label: "a long library source name ".repeat(3), path: "live", kind: "folder" as const }));

describe("tool turns in a small context window", () => {
  it("runs with its tools at 2048 when they fit", async () => {
    const bodies: Record<string, unknown>[] = [];
    const events = [];
    for await (const e of streamToolTurn({ baseUrl: "http://fake", model: "m", messages: [{ role: "user", content: "hi" }], numCtx: 2048, sources: [], fetch: answering(bodies), execute: noRun })) events.push(e);
    expect(bodies[0]).toMatchObject({ options: { num_ctx: 2048 }, tools: expect.any(Array) });
    expect(events.at(-1)).toMatchObject({ type: "done", message: { stats: { numCtx: 2048 } } });
  });

  it("answers without tools and says why when they would take most of the window", async () => {
    const bodies: Record<string, unknown>[] = [];
    const events = [];
    for await (const e of streamToolTurn({ baseUrl: "http://fake", model: "m", messages: [{ role: "user", content: "hi" }], numCtx: 2048, sources: manySources, fetch: answering(bodies), execute: noRun })) events.push(e);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("tools");
    expect(sentMessages(bodies)).toHaveLength(1);
    const note = { name: "note", state: "done", summary: expect.stringMatching(/2k.*without tools/) };
    expect(events[0]).toMatchObject({ type: "tool", step: note });
    expect(events.at(-1)).toMatchObject({ type: "done", message: { content: "ok", tools: [note] } });
  });

  it("drops the oldest history that does not fit beside the tools", async () => {
    const bodies: Record<string, unknown>[] = [];
    const messages = [{ role: "user" as const, content: "x".repeat(8000) }, { role: "assistant" as const, content: "x".repeat(8000) }, { role: "user" as const, content: "now" }];
    for await (const _ of streamToolTurn({ baseUrl: "http://fake", model: "m", messages, numCtx: 2048, sources: [], fetch: answering(bodies), execute: noRun })) { /* drain */ }
    expect(sentMessages(bodies).map((m) => m.role)).toEqual(["system", "user"]);
    expect(sentMessages(bodies).at(-1)?.content).toBe("now");
  });

  it("says so plainly when the message is too long beside the tools, and sends nothing", async () => {
    const bodies: Record<string, unknown>[] = [];
    const events = [];
    for await (const e of streamToolTurn({ baseUrl: "http://fake", model: "m", messages: [{ role: "user", content: "y".repeat(20000) }], numCtx: 2048, sources: [], fetch: answering(bodies), execute: noRun })) events.push(e);
    expect(bodies).toEqual([]);
    expect(events).toEqual([expect.objectContaining({ type: "error", code: "context-too-small" })]);
  });
});

/** What a 2048 window can spend on a request: all but the quarter kept for the reply. */
const ROOM_AT_2048 = 2048 - 512;
/** Estimated tokens of one /api/chat body, tool definitions included. */
const requestTokens = (body: Record<string, unknown>) => (body["messages"] as { content: string; tool_calls?: unknown }[])
  .reduce((sum, m) => sum + estimateTokens(m.content) + (m.tool_calls ? Math.ceil(JSON.stringify(m.tool_calls).length / 4) : 0), 0)
  + (body["tools"] ? estimateTokens(JSON.stringify(body["tools"])) : 0);
/** A model that calls read once and answers on the next request. */
const callsOnceThenAnswers = (bodies: Record<string, unknown>[], native: boolean) => vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url).endsWith("/api/show")) return Response.json({ capabilities: native ? ["completion", "tools"] : ["completion"] });
  bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
  if (bodies.length > 1) return ndjson([{ message: { content: "the answer" }, done: true }]);
  const call = { name: "read", arguments: { path: "/library/s0" } };
  return ndjson([{ message: native ? { tool_calls: [{ function: call }] } : { content: `<tool_call>${JSON.stringify(call)}</tool_call>` }, done: true }]);
});
type Asked = { role: "user" | "assistant"; content: string };
const toolRound = async (o: { native: boolean; numCtx?: number; sources?: number; messages?: Asked[]; output: string }) => {
  const bodies: Record<string, unknown>[] = [];
  const events = [];
  const execute = async () => ({ output: o.output, summary: "Read" });
  for await (const e of streamToolTurn({ baseUrl: "http://fake", model: "m", messages: o.messages ?? [{ role: "user", content: "read it" }], numCtx: o.numCtx ?? 2048, sources: manySources.slice(0, o.sources ?? 0), fetch: callsOnceThenAnswers(bodies, o.native), execute })) events.push(e);
  return { bodies, events, sent: (bodies[1]?.["messages"] ?? []) as { role: string; content: string }[] };
};
const WINDOW_FULL = "\n[cut: this model's context window is full]";

describe("every request of a tool turn fits the context window (R-01)", () => {
  for (const native of [true, false]) {
    const mode = native ? "native" : "text";
    for (const sources of [0, 18]) {
      it(`${mode}, ${sources} sources: a 10,000-character result at 2048 is cut to fit and the model still answers`, async () => {
        const output = "abcdefgh".repeat(1250);
        const { bodies, events, sent } = await toolRound({ native, sources, output });
        expect(bodies).toHaveLength(2);
        expect(bodies.map(requestTokens).filter(tokens => tokens > ROOM_AT_2048)).toEqual([]);
        expect(sent.map(m => m.content).join("")).toContain(output.slice(0, 200));
        expect(events.filter(e => e.type === "error")).toEqual([]);
        expect(events.at(-1)).toMatchObject({ type: "done", message: { content: "the answer", tools: [{ name: "read", state: "done" }] } });
      });
    }
    it(`${mode}: the oldest turns go before the tool's output does`, async () => {
      const older: Asked[] = [{ role: "user", content: "q".repeat(1200) }, { role: "assistant", content: "a".repeat(1200) }, { role: "user", content: "r".repeat(1200) }, { role: "assistant", content: "b".repeat(1200) }];
      const output = "o".repeat(2000);
      const { bodies, sent } = await toolRound({ native, sources: 8, messages: [...older, { role: "user", content: "read it" }], output });
      expect(bodies.map(requestTokens).filter(tokens => tokens > ROOM_AT_2048)).toEqual([]);
      const text = sent.map(m => m.content).join("");
      expect(text).toContain(output);
      expect(text).not.toContain(WINDOW_FULL);
      expect(text).toContain("read it");
      // What is left of the older chat starts with what was asked, never with a reply.
      expect(sent.find(m => m.role !== "system")?.role).toBe("user");
      expect(text).not.toContain("q".repeat(1200));
    });
  }
  it("native: when only the tool definitions stand in the way, the follow-up is sent without them", async () => {
    const first = await toolRound({ native: true, output: "" });
    const room = ROOM_AT_2048 - requestTokens(first.bodies[0]!) + estimateTokens("read it");
    // The question fills the first request, definitions included: no room is left for them beside the call and its result.
    const { bodies, events } = await toolRound({ native: true, messages: [{ role: "user", content: "x".repeat((room - 4) * 4) }], output: "o".repeat(1200) });
    expect(bodies[0]).toHaveProperty("tools");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty("tools");
    expect(bodies.map(requestTokens).filter(tokens => tokens > ROOM_AT_2048)).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "done", message: { content: "the answer" } });
  });
  it("text mode: when nothing more fits, the turn ends with a plain sentence and no second request", async () => {
    const first = await toolRound({ native: false, output: "" });
    const room = ROOM_AT_2048 - requestTokens(first.bodies[0]!) + estimateTokens("read it");
    // The question takes all that the first request has left.
    const { bodies, events } = await toolRound({ native: false, messages: [{ role: "user", content: "x".repeat((room - 4) * 4) }], output: "o".repeat(5000) });
    expect(bodies).toHaveLength(1);
    expect(events.filter(e => e.type === "error")).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "done", message: { content: expect.stringMatching(/2k context.*more context/), tools: [{ name: "read", state: "done" }] } });
  });
  for (const native of [true, false]) {
    it(`${native ? "native" : "text"}: at 16384 a tool result that fits is sent whole and nothing is dropped`, async () => {
      const older: Asked[] = [{ role: "user", content: "q".repeat(4000) }, { role: "assistant", content: "a".repeat(4000) }];
      const output = "z".repeat(10000);
      const { bodies, sent } = await toolRound({ native, numCtx: 16384, messages: [...older, { role: "user", content: "read it" }], output });
      const firstRequest = bodies[0]!["messages"] as unknown[];
      expect(firstRequest).toEqual(sent.slice(0, firstRequest.length));
      expect(sent.at(-1)?.content).toContain(output);
      if (native) expect(bodies[1]).toHaveProperty("tools");
    });
  }
});
