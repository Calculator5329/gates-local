import { describe, expect, it } from "vitest";
import { createGpuLease } from "./lease.ts";

describe("app GPU lease", () => {
  it("queues heavy jobs FIFO, with no whisper job or side effects", async () => {
    const lease = createGpuLease();
    const log: string[] = [];
    const release = await lease.acquire("chat");
    const image = lease.run("image", undefined, async () => { log.push("image"); });
    const dream = lease.run("dream", undefined, async () => { log.push("dream"); });
    expect(lease.status()).toEqual({ holder: "chat", waiting: ["image", "dream"] });
    expect(log).toEqual([]);
    release(); release();
    await Promise.all([image, dream]);
    expect(log).toEqual(["image", "dream"]);
    expect(lease.status()).toEqual({ holder: null, waiting: [] });
  });
  it("removes an aborted waiter without releasing the current holder", async () => {
    const lease = createGpuLease();
    const release = await lease.acquire("chat");
    const abort = new AbortController();
    const waiting = lease.acquire("image", abort.signal);
    abort.abort();
    await expect(waiting).rejects.toThrow();
    expect(lease.status()).toEqual({ holder: "chat", waiting: [] });
    release();
    await expect(lease.acquire("bench", AbortSignal.abort())).rejects.toThrow();
  });
  it("releases a throwing or cancelled job after its cleanup", async () => {
    const lease = createGpuLease();
    await expect(lease.run("bench", undefined, async () => { throw new Error("crash"); })).rejects.toThrow("crash");
    const abort = new AbortController();
    await expect(lease.run("image", abort.signal, async () => {
      abort.abort(); abort.signal.throwIfAborted();
    })).rejects.toThrow();
    const release = await lease.acquire("chat");
    release();
    expect(lease.status().holder).toBeNull();
  });
});
