import { describe, expect, it } from "vitest";
import type { PullProgress } from "@gates-local/contracts";
import { etaText } from "./format.ts";

const GB = 1e9;
const p = (over: Partial<PullProgress>): PullProgress => ({ name: "qwen3.5:9b", state: "downloading", completedBytes: 0, ...over });

describe("download time left", () => {
  it("says seconds under a minute instead of rounding up to a minute", () => {
    // 2.5 GB left at 100 MB/s is 25 s.
    expect(etaText(p({ completedBytes: 4.1 * GB, totalBytes: 6.6 * GB, bytesPerSecond: 100e6 }))).toBe("3.8 of 6.1 GB · 100 MB/s · about 25 s left");
  });

  it("keeps minutes from a minute up", () => {
    expect(etaText(p({ completedBytes: 0, totalBytes: 6.6 * GB, bytesPerSecond: 50e6 }))).toBe("0.0 of 6.1 GB · 50 MB/s · about 3 min left");
  });

  it("labels the phases after the bytes are in instead of a time from download speed", () => {
    expect(etaText(p({ state: "verifying", completedBytes: 6.6 * GB, totalBytes: 6.6 * GB, bytesPerSecond: 90e6 }))).toBe("Verifying the download");
    expect(etaText(p({ completedBytes: 6.6 * GB, totalBytes: 6.6 * GB, bytesPerSecond: 90e6 }))).toBe("Finishing the download");
  });
});
