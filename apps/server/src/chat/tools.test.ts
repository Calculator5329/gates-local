import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { streamToolTurn } from "./tools.ts";
import { createSources } from "../sources/index.ts";
import { createApp } from "../app.ts";
import { openThreadStore } from "../threads/store.ts";

const ndjson = (items: unknown[]) => new Response(items.map(i => JSON.stringify(i)).join("\n") + "\n");
describe("tool chat transport", () => {
  it("chooses native tool_calls from /api/show and carries think and num_ctx", async () => {
    const requests: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (url, init) => {
      if (String(url).endsWith("/api/show")) return Response.json({ capabilities: ["completion", "tools"] });
      requests.push(JSON.parse(String(init?.body)));
      return requests.length === 1 ? ndjson([{ message: { tool_calls: [{ function: { name: "read", arguments: { path: "/library/docs" } } }] }, done: true, done_reason: "stop" }]) : ndjson([{ message: { content: "All done" }, done: true }]);
    });
    const events = [];
    for await (const e of streamToolTurn({ baseUrl: "http://fake", model: "qwen", messages: [{ role: "user", content: "read" }], numCtx: 16384, think: false, sources: [], fetch: fetcher, execute: async () => ({ output: "text", summary: "Read your file" }) })) events.push(e);
    expect(requests[0]).toMatchObject({ tools: expect.any(Array), think: false, options: { num_ctx: 16384 } });
    expect(events.at(-1)).toMatchObject({ type: "done", message: { content: "All done", tools: [{ state: "done" }] } });
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
      runtime: { status: () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }), baseUrl: () => "http://fake", onChange: () => () => {} },
      catalog: { current: () => [], refresh: async () => ({ models: [], changed: false }), onChange: () => () => {} },
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
    it(`chat.send ${image ? "offers and runs" : "neither offers nor runs"} the image tool when image is ${image}`, async () => {
      const root = mkdtempSync(path.join(tmpdir(), "gl-app-image-"));
      const sources = createSources({ dataDir: path.join(root, "data") });
      const file = path.join(root, "notes.txt"); writeFileSync(file, "hello");
      await sources.add({ kind: "file", path: file });
      const store = openThreadStore(path.join(root, "threads.db"));
      const chatBodies: { tools?: { function: { name: string } }[] }[] = [];
      const fetcher = vi.fn(async (url, init) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === "/api/show") return Response.json({ capabilities: ["tools"] });
        if (pathname === "/api/ps") return Response.json({ models: [{ name: "m", model: "m", size: 1000, size_vram: 1000, context_length: 16384, expires_at: "later", digest: "d" }] });
        if (pathname === "/api/tags") return Response.json({ models: [] });
        chatBodies.push(JSON.parse(String(init?.body)));
        return chatBodies.length === 1 ? ndjson([{ message: { tool_calls: [{ function: { name: "image", arguments: { prompt: "a cat" } } }] }, done: true }]) : ndjson([{ message: { content: "done" }, done: true }]);
      });
      vi.stubGlobal("fetch", fetcher);
      const generateImage = vi.fn(async () => "images/cat.png");
      const app = createApp({ store, sources, toolsEnabled: () => true, generateImage,
        runtime: { status: () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }), baseUrl: () => "http://fake", onChange: () => () => {} },
        catalog: { current: () => [], refresh: async () => ({ models: [], changed: false }), onChange: () => () => {} },
        push: () => {}, fit: { runNvidiaSmi: async args => args[0]?.startsWith("--query-gpu") ? "16384, 1024, 15360\n" : "", readMeminfo: async () => "MemAvailable: 32000000 kB\n" },
      });
      try {
        const thread = store.createThread();
        await app.handlers["chat.send"]({ threadId: thread.id, content: "draw", model: "m", numCtx: 16384, ...(image ? { image } : {}) }, { clientId: 1 });
        await vi.waitFor(() => expect(app.activeTurns()).toBe(0));
        const offered = chatBodies[0]!.tools!.map(t => t.function.name);
        const saved = store.getThread(thread.id).messages.at(-1);
        if (image) {
          expect(offered).toContain("image");
          expect(generateImage).toHaveBeenCalledWith("a cat", expect.any(AbortSignal));
          expect(saved).toMatchObject({ images: ["images/cat.png"], tools: [{ name: "image", state: "done" }] });
        } else {
          expect(offered).not.toContain("image");
          expect(generateImage).not.toHaveBeenCalled();
          expect(saved).toMatchObject({ tools: [{ name: "image", state: "error" }] });
        }
      } finally { await app.shutdown(); store.close(); vi.unstubAllGlobals(); }
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
        runtime: { status: () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }), baseUrl: () => "http://fake", onChange: () => () => {} },
        catalog: { current: () => [], refresh: async () => ({ models: [], changed: false }), onChange: () => () => {} },
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
