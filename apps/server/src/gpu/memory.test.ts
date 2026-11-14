// The memory owner alone: what it asks to leave, what it never touches, and when it waits.
import { describe, expect, it } from "vitest";
import type { LoadedModel } from "../runtime/types.ts";
import { createMemoryOwner, type EngineLeave, type MemoryOwnerDeps } from "./memory.ts";

const BASE = "http://ollama.test";
const row = (name: string): LoadedModel => ({ name, sizeBytes: 1e9, sizeVramBytes: 1e9, contextLength: 16384 });

/** A fake Ollama: keep_alive 0 drops the model from /api/ps unless it is sticky. */
function ollama(models: string[], sticky: string[] = []) {
  const listed = new Set(models);
  const asked: string[] = [];
  const fetch = (async (_input: unknown, init?: RequestInit) => {
    const { model, keep_alive } = JSON.parse(String(init?.body)) as { model: string; keep_alive: number };
    expect(keep_alive).toBe(0);
    asked.push(model);
    if (!sticky.includes(model)) listed.delete(model);
    return new Response("{}");
  }) as typeof globalThis.fetch;
  return { asked, fetch, listLoaded: async () => [...listed].map(row), listed };
}

function owner(o: ReturnType<typeof ollama>, more: Partial<MemoryOwnerDeps> = {}) {
  return createMemoryOwner({ ollamaUrl: () => BASE, listLoaded: o.listLoaded, fetch: o.fetch, replying: () => [], waitMs: 100, pollMs: 1, ...more });
}

const signal = new AbortController().signal;
const chat = (model: string) => ({ kind: "chat" as const, model, numCtx: 16384 });

describe("one thing in memory: the handoff", () => {
  it("asks every other model to leave, whoever loaded it, and keeps the one wanted", async () => {
    const o = ollama(["a:1b", "b:2b", "c:3b"]);
    const m = owner(o);
    const h = await m.gate(() => m.handoff(chat("b:2b"), signal));
    expect(o.asked.toSorted()).toEqual(["a:1b", "c:3b"]);
    expect(h.left.toSorted()).toEqual(["a:1b", "c:3b"]);
    expect([...o.listed]).toEqual(["b:2b"]);
  });

  it("never asks a model a running reply uses to leave (a reply on A while B is sent)", async () => {
    const o = ollama(["a:1b"]);
    const m = owner(o, { replying: () => ["a:1b"] });
    const h = await m.handoff(chat("b:2b"), signal);
    expect(o.asked).toEqual([]);
    expect(h.stayed).toEqual(["a:1b"]);
  });

  it("asks only the app's Ollama: nothing else on the GPU (whisper, other programs) is asked anything", async () => {
    const o = ollama(["a:1b"]);
    const urls: string[] = [];
    const fetch = (async (input: unknown, init?: RequestInit) => { urls.push(String(input)); return o.fetch(input as string, init); }) as typeof globalThis.fetch;
    const m = owner(o, { fetch });
    await m.handoff(chat("b:2b"), signal);
    expect(urls).toEqual([`${BASE}/api/generate`]);
  });

  it("a model that never leaves: the wait ends at its bound and it is named as stayed", async () => {
    const o = ollama(["a:1b"], ["a:1b"]);
    const m = owner(o, { waitMs: 60 });
    const started = Date.now();
    const h = await m.handoff(chat("b:2b"), signal);
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    expect(h).toMatchObject({ left: [], stayed: ["a:1b"] });
  });

  it("an unreadable /api/ps claims nothing: stayed is undefined", async () => {
    const m = owner(ollama([]), { listLoaded: async () => { throw new Error("down"); } });
    expect((await m.handoff(chat("b:2b"), signal)).stayed).toBeUndefined();
  });

  it("the engine: freed while idle, never asked while busy, not asked again for the setup it holds", async () => {
    let answer: EngineLeave = "busy";
    let asks = 0;
    const engine = { leave: async () => { asks += 1; return answer; } };
    const m = owner(ollama([]), { engine: () => engine });
    const image = { kind: "image" as const, setup: "p 512x512" };
    expect((await m.handoff(image, signal)).engine).toBe("busy");
    answer = "freed";
    expect((await m.handoff(image, signal)).engine).toBe("freed");
    m.settled(image);
    expect((await m.handoff(image, signal)).engine).toBe("kept");
    expect(asks).toBe(2);
    // A chat model next: the engine holds an image, so it is asked to free.
    expect((await m.handoff(chat("b:2b"), signal)).engine).toBe("freed");
    expect(asks).toBe(3);
    // It holds nothing now: not asked again.
    expect((await m.handoff(chat("b:2b"), signal)).engine).toBe("idle");
    expect(asks).toBe(3);
  });

  it("after something left, the settle reads the GPU until two reads in a row stop rising", async () => {
    const reads = [1e9, 3e9, 5e9, 5e9, 5e9, 5e9];
    let i = 0;
    const m = owner(ollama(["a:1b"]), { readFree: async () => reads[Math.min(i++, reads.length - 1)]! });
    await m.handoff(chat("b:2b"), signal);
    expect(i).toBe(5);
  });

  it("status: the resident thing and the handoff stage", async () => {
    const m = owner(ollama([]));
    await m.handoff(chat("b:2b"), signal);
    expect(m.status().handoff).toMatchObject({ stage: "measuring" });
    m.stage(chat("b:2b"), "loading");
    m.settled(chat("b:2b"));
    expect(m.status()).toMatchObject({ resident: { kind: "chat", model: "b:2b", numCtx: 16384 } });
    expect(m.status().handoff).toBeUndefined();
  });
});
