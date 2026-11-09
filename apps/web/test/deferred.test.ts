import { afterEach, describe, expect, it, vi } from "vitest";
import { afterFirstPaint, deferred } from "../src/deferred.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("deferred screens", () => {
  it("shares the idle import with a cold click, and publishes only the complete screen", async () => {
    let finish!: (value: string) => void;
    const importScreen = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const screen = deferred(importScreen);
    const changed = vi.fn();
    const unsubscribe = screen.subscribe(changed);
    const idle = screen.load();
    const click = screen.load();
    expect(click).toBe(idle);
    await Promise.resolve();
    expect(importScreen).toHaveBeenCalledTimes(1);
    expect(screen.get()).toEqual({ kind: "pending" });
    expect(changed).not.toHaveBeenCalled();
    finish("Settings");
    await idle;
    expect(screen.get()).toEqual({ kind: "ready", value: "Settings" });
    expect(changed).toHaveBeenCalledTimes(1);
    unsubscribe();
    await screen.load();
    expect(importScreen).toHaveBeenCalledTimes(1);
  });

  it("catches missing chunks during idle too, so a later click can offer reload", async () => {
    const importScreen = vi.fn(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module")));
    const screen = deferred(importScreen);
    const changed = vi.fn();
    screen.subscribe(changed);
    await expect(screen.load()).resolves.toBeUndefined();
    expect(screen.get()).toEqual({ kind: "error" });
    expect(changed).toHaveBeenCalledTimes(1);
    await screen.load();
    expect(importScreen).toHaveBeenCalledTimes(1);
  });

  it("waits for two frames and idle, and cancels a StrictMode trial mount", () => {
    const frames: FrameRequestCallback[] = [];
    const cancelFrame = vi.fn();
    const cancelIdle = vi.fn();
    let idle: IdleRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
    vi.stubGlobal("requestIdleCallback", vi.fn((cb: IdleRequestCallback) => { idle = cb; return 7; }));
    vi.stubGlobal("cancelIdleCallback", cancelIdle);
    const work = vi.fn();
    const cancel = afterFirstPaint(work);
    expect(work).not.toHaveBeenCalled();
    frames.shift()!(0);
    expect(idle).toBeUndefined();
    frames.shift()!(16);
    expect(work).not.toHaveBeenCalled();
    expect(requestIdleCallback).toHaveBeenCalledWith(work, { timeout: 1500 });
    idle!({ didTimeout: false, timeRemaining: () => 20 });
    expect(work).toHaveBeenCalledTimes(1);
    cancel();
    expect(cancelIdle).toHaveBeenCalledWith(7);
    const cancelTrial = afterFirstPaint(work);
    cancelTrial();
    expect(cancelFrame).toHaveBeenLastCalledWith(1);
  });

  it("warms after paint on browsers without requestIdleCallback and cancels that timer", () => {
    vi.useFakeTimers();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("requestIdleCallback", undefined);
    const work = vi.fn();
    const cancel = afterFirstPaint(work);
    frames.shift()!(0);
    frames.shift()!(16);
    expect(work).not.toHaveBeenCalled();
    cancel();
    vi.runAllTimers();
    expect(work).not.toHaveBeenCalled();
    afterFirstPaint(work);
    frames.shift()!(32);
    frames.shift()!(48);
    vi.runAllTimers();
    expect(work).toHaveBeenCalledTimes(1);
  });
});
