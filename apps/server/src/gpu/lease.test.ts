import { afterEach, describe, expect, it, vi } from "vitest";
import { createGpuLease } from "./lease.ts";

const effects = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("node:child_process", () => Object.fromEntries(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"].map((name) => [name, (...args: unknown[]) => { effects.calls.push(`${name} ${args.map(String).join(" ")}`); }])));
afterEach(() => { vi.unstubAllGlobals(); effects.calls.length = 0; });

describe("app GPU lease", () => {
  it("queues heavy jobs FIFO, with no whisper job or side effects", async () => {
    vi.stubGlobal("fetch", (...args: unknown[]) => { effects.calls.push(`fetch ${args.map(String).join(" ")}`); return Promise.resolve(Response.json({})); });
    const lease = createGpuLease();
    const log: string[] = [];
    const release = await lease.acquire("chat");
    const image = lease.run("image", undefined, async () => { log.push("image"); });
    const dream = lease.run("dream", undefined, async () => { log.push("dream"); });
    expect(lease.status()).toEqual({ holder: "chat", holders: 1, waiting: ["image", "dream"] });
    expect(log).toEqual([]);
    release(); release();
    await Promise.all([image, dream]);
    expect(log).toEqual(["image", "dream"]);
    expect(lease.status()).toEqual({ holder: null, holders: 0, waiting: [] });
    expect(effects.calls.filter((call) => /whisper(?:-server)?/i.test(call))).toEqual([]);
    expect(effects.calls).toEqual([]);
  });
  it("removes an aborted waiter without releasing the current holder", async () => {
    const lease = createGpuLease();
    const release = await lease.acquire("chat");
    const abort = new AbortController();
    const waiting = lease.acquire("image", abort.signal);
    abort.abort();
    await expect(waiting).rejects.toThrow();
    expect(lease.status()).toEqual({ holder: "chat", holders: 1, waiting: [] });
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
  it("lets chat claims hold the GPU together while an image job waits for all of them", async () => {
    const lease = createGpuLease();
    const turnA = await lease.acquire("chat");
    const turnB = await lease.acquire("chat");
    expect(lease.status()).toEqual({ holder: "chat", holders: 2, waiting: [] });
    let imaged = false;
    const image = lease.run("image", undefined, async () => { imaged = true; });
    await Promise.resolve();
    turnA();
    await Promise.resolve();
    expect(imaged).toBe(false);
    expect(lease.status()).toEqual({ holder: "chat", holders: 1, waiting: ["image"] });
    turnB();
    await image;
    expect(imaged).toBe(true);
    expect(lease.status()).toEqual({ holder: null, holders: 0, waiting: [] });
  });
  it("queues a chat claim behind a waiting image job, so turns cannot starve it", async () => {
    const lease = createGpuLease();
    const order: string[] = [];
    const turnA = await lease.acquire("chat");
    const image = lease.run("image", undefined, async () => { order.push("image"); });
    const turnB = lease.acquire("chat").then((release) => { order.push("chat B"); release(); });
    await Promise.resolve();
    expect(lease.status()).toEqual({ holder: "chat", holders: 1, waiting: ["image", "chat"] });
    turnA();
    await Promise.all([image, turnB]);
    expect(order).toEqual(["image", "chat B"]);
  });
  it("hands the GPU to the chat claims behind an image waiter that gave up", async () => {
    const lease = createGpuLease();
    const turnA = await lease.acquire("chat");
    const abort = new AbortController();
    const image = lease.acquire("image", abort.signal);
    let turnB: (() => void) | undefined;
    const waitingB = lease.acquire("chat").then((release) => { turnB = release; });
    abort.abort(new Error("cancelled"));
    await expect(image).rejects.toThrow("cancelled");
    await waitingB;
    expect(lease.status()).toEqual({ holder: "chat", holders: 2, waiting: [] });
    turnA(); turnB?.();
    expect(lease.status()).toEqual({ holder: null, holders: 0, waiting: [] });
  });
  it("runs exclusive kinds one at a time and never beside a chat claim", async () => {
    const lease = createGpuLease();
    const image = await lease.acquire("image");
    let chatted = false, benched = false;
    const chat = lease.acquire("chat").then((release) => { chatted = true; release(); });
    const bench = lease.run("bench", undefined, async () => { benched = true; });
    await Promise.resolve();
    expect([chatted, benched]).toEqual([false, false]);
    expect(lease.status()).toEqual({ holder: "image", holders: 1, waiting: ["chat", "bench"] });
    image();
    await Promise.all([chat, bench]);
    expect([chatted, benched]).toEqual([true, true]);
  });
});
