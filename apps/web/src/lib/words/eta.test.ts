import { describe, expect, it } from "vitest";
import type { PullProgress } from "@gates-local/contracts";
import { etaText, timeLeft } from "./format.ts";

const GB = 1e9;
const SP = String.fromCharCode(160);
const p = (over: Partial<PullProgress>): PullProgress => ({ name: "qwen3.5:9b", state: "downloading", completedBytes: 0, ...over });

describe("download time left", () => {
  it("says seconds under a minute instead of rounding up to a minute", () => {
    // 2.5 GB left at 100 MB/s is 25 s.
    expect(etaText(p({ completedBytes: 4.1 * GB, totalBytes: 6.6 * GB, bytesPerSecond: 100e6 }))).toBe(`3.8 of 6.1${SP}GB · 100 MB/s · about 25 s left`);
  });

  it("keeps minutes from a minute up", () => {
    expect(etaText(p({ completedBytes: 0, totalBytes: 6.6 * GB, bytesPerSecond: 50e6 }))).toBe(`0.0 of 6.1${SP}GB · 50 MB/s · about 3 min left`);
  });

  it("labels the phases after the bytes are in instead of a time from download speed", () => {
    expect(etaText(p({ state: "verifying", completedBytes: 6.6 * GB, totalBytes: 6.6 * GB, bytesPerSecond: 90e6 }))).toBe("Verifying the download");
    expect(etaText(p({ completedBytes: 6.6 * GB, totalBytes: 6.6 * GB, bytesPerSecond: 90e6 }))).toBe("Finishing the download");
  });
  // Owner 2026-11-13: a model in several files read "0.2 of 1.1 GB", the first file's size, as if it were the model's.
  it("says what has arrived, with no total and no time left, while the whole size is unknown", () => {
    expect(etaText(p({ completedBytes: 0.2 * 1024 ** 3, bytesPerSecond: 15e6 }))).toBe(`0.2${SP}GB so far · 15 MB/s`);
    // council climb-025 Q15: a bare "Starting" beside "…" never said what was starting
    expect(etaText(p({ completedBytes: 0 }))).toBe("Starting the download");
  });
});

describe("time left on its own", () => {
  it("says whole seconds under 10 s and rounds up to the next 5 s from there to a minute", () => {
    expect(timeLeft(0.2)).toBe("1 s");
    expect(timeLeft(3)).toBe("3 s");
    expect(timeLeft(7.4)).toBe("7 s");
    expect(timeLeft(9)).toBe("9 s");
    expect(timeLeft(10)).toBe("10 s");
    expect(timeLeft(11)).toBe("15 s");
    expect(timeLeft(21)).toBe("25 s");
    expect(timeLeft(54)).toBe("55 s");
    expect(timeLeft(56)).toBe("1 min");
  });
});
