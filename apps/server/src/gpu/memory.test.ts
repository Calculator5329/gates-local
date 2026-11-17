// The memory owner alone: what it asks to leave, what it never touches, and when it waits.
import type { MemoryState } from "@gates-local/contracts";
import { describe, expect, it } from "vitest";
import type { LoadedModel } from "../runtime/types.ts";
import { createMemoryOwner, LEAVE_POLL_MS, LEAVE_WAIT_MS, type EngineLeave, type MemoryOwnerDeps } from "./memory.ts";

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
const appLoaded = (m: ReturnType<typeof owner>, ...tags: string[]) => { for (const tag of tags) m.loaded.loaded(tag, 16384); return m; };

describe("one thing in memory: the handoff", () => {
  it("asks every other model the app loaded to leave and keeps the one wanted", async () => {
    const o = ollama(["a:1b", "b:2b", "c:3b"]);
    const m = appLoaded(owner(o), "a:1b", "b:2b", "c:3b");
    const h = await m.gate(() => m.handoff(chat("b:2b"), signal));
    expect(o.asked.toSorted()).toEqual(["a:1b", "c:3b"]);
    expect(h.left.toSorted()).toEqual(["a:1b", "c:3b"]);
    expect(h.held).toEqual([]);
    expect([...o.listed]).toEqual(["b:2b"]);
  });

  it("a model another program loaded is not asked: it stays and is named with what it holds", async () => {
    const o = ollama(["mine:1b", "theirs:7b"]);
    const m = appLoaded(owner(o), "mine:1b");
    const h = await m.gate(() => m.handoff(chat("b:2b"), signal));
    expect(o.asked).toEqual(["mine:1b"]);
    expect(h.left).toEqual(["mine:1b"]);
    expect(h.held).toEqual([{ kind: "model", name: "theirs:7b", bytes: 1e9 }]);
    expect([...o.listed]).toEqual(["theirs:7b"]);
  });

  it("with \"don't ask again\" saved, another program's model is asked to leave too", async () => {
    const o = ollama(["mine:1b", "theirs:7b"]);
    const m = appLoaded(owner(o, { freeOthers: () => true }), "mine:1b");
    const h = await m.gate(() => m.handoff(chat("b:2b"), signal));
    expect(o.asked.toSorted()).toEqual(["mine:1b", "theirs:7b"]);
    expect(h.held).toEqual([]);
  });

  it("free: asks only the named models to leave, then they are gone", async () => {
    const o = ollama(["mine:1b", "theirs:7b", "other:3b"]);
    const m = owner(o);
    const h = await m.gate(() => m.free([{ kind: "model", name: "theirs:7b", bytes: 1e9 }], signal));
    expect(o.asked).toEqual(["theirs:7b"]);
    expect(h.left).toEqual(["theirs:7b"]);
    expect([...o.listed].toSorted()).toEqual(["mine:1b", "other:3b"]);
  });

  it("a ComfyUI the app did not start: a chat leaves it and names what it holds; a picture frees it", async () => {
    let asks = 0;
    const engine = { leave: async () => { asks += 1; return "freed" as const; }, ours: () => false, holds: async () => 9e9 };
    const m = owner(ollama([]), { engine: () => engine });
    const h = await m.handoff(chat("b:2b"), signal);
    expect(h).toMatchObject({ engine: "foreign", held: [{ kind: "engine", name: "ComfyUI", bytes: 9e9 }] });
    expect(asks).toBe(0);
    expect((await m.handoff({ kind: "image", setup: "p 512x512" }, signal)).engine).toBe("freed");
    expect(asks).toBe(1);
  });

  it("a ComfyUI the app did not start: Free it asks it, and with \"don't ask again\" a chat asks it", async () => {
    let asks = 0;
    const engine = { leave: async () => { asks += 1; return "freed" as const; }, ours: () => false, holds: async () => 9e9 };
    const m = owner(ollama([]), { engine: () => engine });
    expect((await m.free([{ kind: "engine", name: "ComfyUI", bytes: 9e9 }], signal)).left).toEqual(["ComfyUI"]);
    expect(asks).toBe(1);
    const always = owner(ollama([]), { engine: () => engine, freeOthers: () => true });
    expect((await always.handoff(chat("b:2b"), signal)).engine).toBe("freed");
    expect(asks).toBe(2);
  });

  it("a ComfyUI the app did not start that holds nothing is idle and named nowhere", async () => {
    const m = owner(ollama([]), { engine: () => ({ leave: async () => "freed" as const, ours: () => false, holds: async () => 0 }) });
    expect(await m.handoff(chat("b:2b"), signal)).toMatchObject({ engine: "idle", held: [] });
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
    const m = appLoaded(owner(o, { fetch }), "a:1b");
    await m.handoff(chat("b:2b"), signal);
    expect(urls).toEqual([`${BASE}/api/generate`]);
  });

  it("a model that never leaves: the wait ends at its bound and it is named as stayed", async () => {
    const o = ollama(["a:1b"], ["a:1b"]);
    const m = appLoaded(owner(o, { waitMs: 60 }), "a:1b");
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
    const m = appLoaded(owner(ollama(["a:1b"]), { readFree: async () => reads[Math.min(i++, reads.length - 1)]! }), "a:1b");
    await m.handoff(chat("b:2b"), signal);
    expect(i).toBe(5);
  });

  it("a computer with no card to read has nothing to settle: one reading, no waiting", async () => {
    let i = 0;
    const m = appLoaded(owner(ollama(["a:1b"]), { readFree: async () => { i++; return undefined; }, pollMs: 250, waitMs: 20_000 }), "a:1b");
    const started = performance.now();
    await m.handoff(chat("b:2b"), signal);
    expect(i).toBe(1);
    expect(performance.now() - started).toBeLessThan(200);
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

  it("the record: a reading that drops the app's model returns it with its num_ctx, and a refused switch gets back what clear took", () => {
    const m = owner(ollama([]));
    m.loaded.loaded("a:1b", 8192);
    m.loaded.loaded("b:2b", 16384);
    expect(m.loaded.observe([{ name: "b:2b" }, { name: "other:1b" }])).toEqual([["a:1b", 8192]]);
    expect(m.loaded.ours()).toEqual(["b:2b"]);
    expect(m.loaded.oursAt("a:1b")).toBeUndefined();
    const kept = m.loaded.clear();
    expect(m.loaded.listed()).toEqual([]);
    expect(m.loaded.ours()).toEqual([]);
    m.loaded.restore(kept);
    expect(m.loaded.listed().toSorted()).toEqual(["b:2b", "other:1b"]);
    expect(m.loaded.oursAt("b:2b")).toBe(16384);
    expect(m.loaded.left("b:2b")).toBe(16384);
    expect(m.loaded.left("other:1b")).toBeUndefined();
  });

  it("a model the app did not ask for is what is in memory all the same, until a reading no longer lists it", () => {
    const m = owner(ollama([]));
    m.observe([row("x:3b")]);
    expect(m.status().resident).toMatchObject({ kind: "chat", model: "x:3b", numCtx: 16384 });
    m.observe([]);
    expect(m.status().resident).toBeUndefined();
  });

  it("tells on when it asks something to leave and off once the wait ended; a busy engine was asked nothing and tells nothing", async () => {
    const told: boolean[] = [];
    const image = { kind: "image" as const, setup: "p 512x512" };
    const busy = owner(ollama([]), { engine: () => ({ leave: async () => "busy" as const }) });
    await busy.handoff(image, signal, { onLeave: (on) => told.push(on) });
    expect(told).toEqual([]);
    const freed = owner(ollama([]), { engine: () => ({ leave: async () => "freed" as const }) });
    await freed.handoff(image, signal, { onLeave: (on) => told.push(on) });
    expect(told).toEqual([true, false]);
  });

  it("an image that failed while loading leaves the engine's setup unknown: the next image asks it to free again", async () => {
    let asks = 0;
    const m = owner(ollama([]), { engine: () => ({ leave: async () => { asks += 1; return "freed" as const; } }) });
    const image = { kind: "image" as const, setup: "p 512x512" };
    await m.handoff(image, signal);
    m.settled(image);
    expect((await m.handoff(image, signal)).engine).toBe("kept");
    m.stage(image, "loading");
    m.ended();
    expect((await m.handoff(image, signal)).engine).toBe("freed");
    expect(asks).toBe(2);
  });
});

/**
 * An Ollama that holds one model, with the real bounds (20 s, a read every 250 ms) on a fake clock:
 * `t` is what the wait costs. The old model stays in /api/ps for `psReads` reads after its unload;
 * the card reads `free` in turn.
 */
function slowDriver(psReads: number, free: number[]) {
  const o = ollama(["a:1b"], ["a:1b"]);
  let t = 0;
  let left = Infinity;
  let i = 0;
  const fetch = (async (input: unknown, init?: RequestInit) => {
    left = psReads;
    return o.fetch(input as string, init);
  }) as typeof globalThis.fetch;
  const listLoaded = async () => {
    if (left !== Infinity && left-- <= 0) o.listed.delete("a:1b");
    return o.listLoaded();
  };
  const m = owner(o, {
    fetch, listLoaded, holdsOne: () => true, waitMs: LEAVE_WAIT_MS, pollMs: LEAVE_POLL_MS,
    now: () => t, sleep: async (ms) => { t += ms; },
    readFree: async () => free[Math.min(i++, free.length - 1)],
  });
  return { m, o, elapsed: () => t, reads: () => i };
}

describe("an Ollama that holds one model (the app's own)", () => {
  it("a chat handoff asks the old model to leave and waits until /api/ps drops it and the card gives back what the plan counted", async () => {
    // 2 GB free with a:1b (1 GB on the card) loaded: the plan counts 3 GB, within the 0.5 GB margin.
    const d = slowDriver(2, [2e9, 2e9, 2e9, 2.6e9]);
    const h = await d.m.gate(() => d.m.handoff(chat("b:2b"), signal));
    expect(d.o.asked).toEqual(["a:1b"]);
    expect(h).toMatchObject({ left: ["a:1b"], stayed: [] });
    // two reads of /api/ps that still list it (500 ms), then two card reads short of it (500 ms):
    // the reading held still on the way, where two flat reads alone would have ended the wait.
    expect(d.reads()).toBe(4);
    expect(d.elapsed()).toBe(1_000);
  });

  it("a driver that frees at once costs no pause: one /api/ps read and two card reads", async () => {
    const d = slowDriver(0, [2e9, 3e9]);
    await d.m.gate(() => d.m.handoff(chat("b:2b"), signal));
    expect(d.o.asked).toEqual(["a:1b"]);
    expect(d.reads()).toBe(2);
    expect(d.elapsed()).toBe(0);
  });

  it("a card that never gives the memory back: the wait ends at the 20 s bound and the load goes on", async () => {
    const d = slowDriver(0, [2e9]);
    const h = await d.m.gate(() => d.m.handoff(chat("b:2b"), signal));
    expect(h.left).toEqual(["a:1b"]);
    expect(d.elapsed()).toBe(LEAVE_WAIT_MS);
  });

  it("a model that never leaves /api/ps: that wait ends at its bound too, and it is named as stayed", async () => {
    const d = slowDriver(Infinity, [2e9]);
    const h = await d.m.gate(() => d.m.handoff(chat("b:2b"), signal));
    expect(h).toMatchObject({ left: [], stayed: ["a:1b"] });
    expect(d.elapsed()).toBe(LEAVE_WAIT_MS);
  });

  it("with no card to read the old model is still asked to leave, and nothing waits on the card", async () => {
    const d = slowDriver(0, []);
    const h = await d.m.gate(() => d.m.handoff(chat("b:2b"), signal));
    expect(h.left).toEqual(["a:1b"]);
    expect(d.elapsed()).toBe(0);
  });

  it("an image still asks every chat model to leave: Ollama frees nothing for ComfyUI", async () => {
    const o = ollama(["a:1b"]);
    const m = owner(o, { holdsOne: () => true });
    const h = await m.handoff({ kind: "image", setup: "p 512x512" }, signal);
    expect(o.asked).toEqual(["a:1b"]);
    expect(h.left).toEqual(["a:1b"]);
  });

  it("a load clears the other models from the record at once and names the app's that left", () => {
    const m = owner(ollama([]), { holdsOne: () => true });
    m.loaded.observe([{ name: "other:1b" }]);
    expect(m.loaded.loaded("a:1b", 8192)).toEqual([]);
    expect(m.loaded.listed()).toEqual(["a:1b"]);
    expect(m.loaded.loaded("b:2b", 16384)).toEqual([["a:1b", 8192]]);
    expect(m.loaded.listed()).toEqual(["b:2b"]);
    expect(m.loaded.ours()).toEqual(["b:2b"]);
  });

  it("an Ollama the person runs keeps both in the record, as before", () => {
    const m = owner(ollama([]));
    m.loaded.loaded("a:1b", 8192);
    expect(m.loaded.loaded("b:2b", 16384)).toEqual([]);
    expect(m.loaded.listed().toSorted()).toEqual(["a:1b", "b:2b"]);
  });
});

describe("memory.changed", () => {
  it("a handoff pushes each stage as it moves: leaving, measuring, loading, then what is resident", async () => {
    const pushed: MemoryState[] = [];
    const m = owner(ollama(["a:1b"]), { onChanged: (s) => pushed.push(s), now: () => 5 });
    await m.handoff(chat("b:2b"), signal);
    m.stage(chat("b:2b"), "loading");
    m.settled(chat("b:2b"));
    const to = { kind: "chat", model: "b:2b", numCtx: 16384 };
    expect(pushed).toEqual([
      { handoff: { to, stage: "leaving" } },
      { handoff: { to, stage: "measuring" } },
      { handoff: { to, stage: "loading" } },
      { resident: { ...to, since: 5 } },
    ]);
  });

  it("a model coming into memory or leaving it is pushed once each, and a reading that changes nothing pushes nothing", () => {
    const pushed: MemoryState[] = [];
    const m = owner(ollama([]), { onChanged: (s) => pushed.push(s), now: () => 5 });
    m.observe([row("a:1b")]);
    m.observe([row("a:1b")]);
    m.observe([]);
    m.observe([]);
    expect(pushed).toEqual([
      { resident: { kind: "chat", model: "a:1b", numCtx: 16384, since: 5 } },
      {},
    ]);
  });
});
