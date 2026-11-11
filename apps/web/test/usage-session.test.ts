import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageRead } from "../src/usage-data.ts";

let store: typeof import("../src/store.ts");
let usage: typeof import("../src/session/usage.ts");
let loaders: typeof import("../src/screen-loaders.ts");

const row = (completionTokens: number): UsageRead => ({
  models: ["a"],
  rows: [{ hour: 0, model: "a", promptTokens: 10, completionTokens, replies: 1, decodeMs: 100, decodeTokens: completionTokens, readMs: 10, readTokens: 10, wallMs: 200 }],
});

const quiet = { beforeOpen: () => {}, asked: () => {}, enter: () => {}, exit: () => {} };

function held() {
  const waiting: Array<(r: UsageRead) => void> = [];
  const read = vi.fn(() => new Promise<UsageRead>((resolve) => { waiting.push(resolve); }));
  return { read, answer: (r: UsageRead) => waiting.shift()!(r) };
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", () => 0);
  store = await import("../src/store.ts");
  usage = await import("../src/session/usage.ts");
  loaders = await import("../src/screen-loaders.ts");
  vi.spyOn(loaders.usageScreen, "load").mockResolvedValue(undefined);
  store.setState({ view: "thread", threadId: "t1" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the Usage pop-up opens complete", () => {
  it("waits for a quick first read, so it opens with figures", async () => {
    const { read, answer } = held();
    const u = usage.createUsage({ read, ...quiet });
    const opened = u.openUsage();
    await vi.advanceTimersByTimeAsync(40);
    expect(store.getState().panel).toBeNull();
    answer(row(5));
    await opened;
    expect(store.getState().panel).toBe("usage");
    expect(u.usageData.get().read).toEqual(row(5));
  });

  it("a slow read opens on placeholders after the wait, then fills in", async () => {
    const { read, answer } = held();
    const u = usage.createUsage({ read, ...quiet });
    const opened = u.openUsage();
    await vi.advanceTimersByTimeAsync(usage.FIRST_READ_WAIT_MS);
    await opened;
    expect(store.getState().panel).toBe("usage");
    expect(u.usageData.get()).toEqual({ read: null, failed: false });
    answer(row(5));
    await vi.advanceTimersByTimeAsync(0);
    expect(u.usageData.get().read).toEqual(row(5));
  });

  it("a close during the wait wins", async () => {
    const { read, answer } = held();
    const u = usage.createUsage({ read, ...quiet });
    const opened = u.openUsage();
    u.closeUsage();
    answer(row(5));
    await opened;
    expect(store.getState().panel).toBeNull();
  });

  it("leaves Settings, which the pop-up replaces", async () => {
    const { read, answer } = held();
    const beforeOpen = vi.fn();
    const u = usage.createUsage({ read, ...quiet, beforeOpen });
    const opened = u.openUsage();
    answer(row(5));
    await opened;
    expect(beforeOpen).toHaveBeenCalledOnce();
  });
});

describe("the footer icon toggles it", () => {
  it("opens, then closes", async () => {
    const { read, answer } = held();
    const u = usage.createUsage({ read, ...quiet });
    u.toggleUsage();
    answer(row(5));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().panel).toBe("usage");
    u.toggleUsage();
    expect(store.getState().panel).toBeNull();
  });
});

describe("a turn ending", () => {
  it("reads again while open, never two reads at once, and not at all while closed", async () => {
    const { read, answer } = held();
    const u = usage.createUsage({ read, ...quiet });
    u.usageChanged();
    expect(read).not.toHaveBeenCalled();
    const opened = u.openUsage();
    answer(row(1));
    await opened;
    expect(read).toHaveBeenCalledTimes(1);
    u.usageChanged();
    u.usageChanged();
    u.usageChanged();
    expect(read).toHaveBeenCalledTimes(2);
    answer(row(2));
    await vi.advanceTimersByTimeAsync(0);
    // the pushes that came during that read make one more, which sees them all
    expect(read).toHaveBeenCalledTimes(3);
    answer(row(3));
    await vi.advanceTimersByTimeAsync(0);
    expect(u.usageData.get().read).toEqual(row(3));
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("a failed re-read keeps the figures on show", async () => {
    let fail = false;
    const read = vi.fn(async () => {
      if (fail) throw new Error("down");
      return row(1);
    });
    const u = usage.createUsage({ read, ...quiet });
    await u.openUsage();
    fail = true;
    u.usageChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(u.usageData.get()).toEqual({ read: row(1), failed: false });
  });
});
