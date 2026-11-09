import { describe, expect, it } from "vitest";
import { createScheduler } from "./scheduler.ts";
import type { LoadedEntry } from "./fake-ollama.ts";

const a: LoadedEntry = { name: "alpha", numCtx: 8192, sizeBytes: 6 };
const b: LoadedEntry = { name: "beta", numCtx: 8192, sizeBytes: 6 };
const signal = () => new AbortController();

describe("the concurrency fake's declared assumptions", () => {
  it("one slot queues, two slots overlap, and cancellation never consumes a slot", async () => {
    for (const limit of [1, 2]) {
      const scheduler = createScheduler(() => [a], () => {});
      const first = await scheduler.acquire(a, signal().signal, limit, 12);
      const abort = signal();
      let admitted = false;
      const second = scheduler.acquire(a, abort.signal, limit, 12).then((r) => { admitted = r !== undefined; return r; });
      await Promise.resolve();
      expect(admitted).toBe(limit === 2);
      if (limit === 1) abort.abort();
      const release = await second;
      expect(release !== undefined).toBe(limit === 2);
      first?.(); release?.();
      const third = await scheduler.acquire(a, signal().signal, limit, 12);
      expect(third).toBeTypeOf("function"); third?.();
    }
  });

  it("a context reload waits for every active slot and blocks newer requests at the old context", async () => {
    const scheduler = createScheduler(() => [a], () => {});
    const first = await scheduler.acquire(a, signal().signal, 2, 12);
    const second = await scheduler.acquire(a, signal().signal, 2, 12);
    const order: string[] = [];
    const reload = scheduler.acquire({ ...a, numCtx: 16384 }, signal().signal, 2, 12).then((r) => { order.push("reload"); return r; });
    const old = scheduler.acquire(a, signal().signal, 2, 12).then((r) => { order.push("old"); return r; });
    first?.(); await Promise.resolve(); expect(order).toEqual([]);
    second?.(); const release = await reload; expect(order).toEqual(["reload"]);
    release?.(); (await old)?.(); expect(order).toEqual(["reload", "old"]);
  });

  it("active memory cannot be evicted; idle memory is evicted and both-fit models overlap", async () => {
    let loaded = [a, b];
    const scheduler = createScheduler(() => loaded, (names) => { loaded = loaded.filter((l) => !names.includes(l.name)); });
    const first = await scheduler.acquire(a, signal().signal, 1, 12);
    const beside = await scheduler.acquire(b, signal().signal, 1, 12);
    beside?.();
    let started = false;
    const waits = scheduler.acquire(b, signal().signal, 1, 8).then((r) => { started = true; return r; });
    await Promise.resolve(); expect(started).toBe(false);
    expect(loaded).toEqual([a, b]);
    first?.(); const release = await waits;
    expect(loaded).toEqual([b]); release?.();
  });

  it("counts memory reserved before a cold load starts", async () => {
    const scheduler = createScheduler(() => [], () => {});
    const first = await scheduler.acquire(a, signal().signal, 1, 8);
    let started = false;
    const second = scheduler.acquire(b, signal().signal, 1, 8).then((r) => { started = true; return r; });
    await Promise.resolve(); expect(started).toBe(false);
    first?.(); (await second)?.(); expect(started).toBe(true);
  });
});
