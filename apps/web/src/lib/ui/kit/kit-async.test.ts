// The kit's plain helpers: a wait with a limit, a debounce, idle work, a saved file.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DOWNLOAD_KEEP_MS, debounce, downloadBlob, withTimeout } from "./async.ts";
import { NO_IDLE_WAIT_MS, scheduleIdle, whenIdle } from "./idle.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("a wait that ends in time gives its value and clears its timer", async () => {
  const late = vi.fn(() => "late");
  await expect(withTimeout(Promise.resolve("read"), 1000, late)).resolves.toBe("read");
  expect(vi.getTimerCount()).toBe(0);
  expect(late).not.toHaveBeenCalled();
});

it("a wait past its limit gives the late value; a failure passes through", async () => {
  const slow = withTimeout(new Promise<string>(() => undefined), 1000, () => "late" as const);
  await vi.advanceTimersByTimeAsync(1000);
  await expect(slow).resolves.toBe("late");
  await expect(withTimeout(Promise.reject(new Error("no")), 1000, () => "late")).rejects.toThrow("no");
  expect(vi.getTimerCount()).toBe(0);
});

it("a debounce runs once, with the last arguments, after the pause; cancel drops it", () => {
  const fn = vi.fn();
  const d = debounce(fn, 150);
  d("a"); vi.advanceTimersByTime(100); d("ab"); vi.advanceTimersByTime(149);
  expect(fn).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(fn).toHaveBeenCalledExactlyOnceWith("ab");
  d("abc"); d.cancel(); vi.advanceTimersByTime(1000);
  expect(fn).toHaveBeenCalledTimes(1);
});

it("idle work waits two frames and the idle time, and a cancel stops it at any point", () => {
  const frames: FrameRequestCallback[] = [];
  const idle: (() => void)[] = [];
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => frames.push(f));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames[id - 1] = () => undefined; });
  vi.stubGlobal("requestIdleCallback", (f: () => void, o: { timeout: number }) => { expect(o.timeout).toBe(1500); return idle.push(f); });
  vi.stubGlobal("cancelIdleCallback", (id: number) => { idle[id - 1] = () => undefined; });
  const work = vi.fn();
  scheduleIdle(work);
  frames.shift()!(0);
  expect(idle).toHaveLength(0);
  frames.shift()!(0);
  expect(work).not.toHaveBeenCalled();
  idle.shift()!();
  expect(work).toHaveBeenCalledTimes(1);
  const other = vi.fn();
  const cancel = scheduleIdle(other);
  frames.shift()!(0);
  cancel();
  for (const f of frames.splice(0)) f(0);
  for (const f of idle.splice(0)) f();
  expect(other).not.toHaveBeenCalled();
});

it("an idle slice runs in idle time with the time left, or after its limit; a cancel stops it", () => {
  const idle: { f: IdleRequestCallback; timeout: number }[] = [];
  vi.stubGlobal("requestIdleCallback", (f: IdleRequestCallback, o: { timeout: number }) => idle.push({ f, timeout: o.timeout }));
  vi.stubGlobal("cancelIdleCallback", (id: number) => { idle[id - 1]!.f = () => undefined; });
  const left: number[] = [];
  whenIdle((timeLeft) => left.push(timeLeft()), 100);
  expect(idle.map((i) => i.timeout)).toEqual([100]);
  idle[0]!.f({ didTimeout: false, timeRemaining: () => 12 });
  expect(left).toEqual([12]);
  const other = vi.fn();
  whenIdle(other, 100)();
  idle[1]!.f({ didTimeout: false, timeRemaining: () => 12 });
  expect(other).not.toHaveBeenCalled();
});

it("with no idle callback, a slice waits a short pause and has no idle time to spend", () => {
  vi.stubGlobal("requestIdleCallback", undefined);
  const left: number[] = [];
  whenIdle((timeLeft) => left.push(timeLeft()), 100);
  vi.advanceTimersByTime(NO_IDLE_WAIT_MS - 1);
  expect(left).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(left).toEqual([0]);
  const other = vi.fn();
  whenIdle(other, 100)();
  vi.advanceTimersByTime(1000);
  expect(other).not.toHaveBeenCalled();
});

it("a saved file's address lives until the download has started, then is let go", () => {
  const revoked: string[] = [];
  const clicked: { href: string; download: string }[] = [];
  vi.stubGlobal("URL", { createObjectURL: () => "blob:one", revokeObjectURL: (u: string) => revoked.push(u) });
  vi.stubGlobal("document", { createElement: () => ({ href: "", download: "", rel: "", click() { clicked.push({ href: this.href, download: this.download }); } }) });
  downloadBlob(new Blob(["x"]), "a.md");
  expect(clicked).toEqual([{ href: "blob:one", download: "a.md" }]);
  vi.advanceTimersByTime(DOWNLOAD_KEEP_MS - 1);
  expect(revoked).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(revoked).toEqual(["blob:one"]);
});
