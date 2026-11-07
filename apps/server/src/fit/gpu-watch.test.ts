import type { GpuStatus } from "@gates-local/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MIB } from "./constants.ts";
import { createGpuWatcher, gpuChanged } from "./gpu-watch.ts";

const status = (freeMib: number, whisperMib = 2202): GpuStatus => ({
  vendor: "nvidia",
  totalBytes: 16303 * MIB,
  freeBytes: freeMib * MIB,
  occupants: [{ label: "Whisper", bytes: whisperMib * MIB, kind: "whisper", protected: true }],
  systemMemoryAvailableBytes: 1,
  measuredAt: 0,
});

const noGpu = (bytes: number): GpuStatus => ({ vendor: "none", occupants: [], systemMemoryAvailableBytes: bytes, measuredAt: 0 });

afterEach(() => {
  vi.useRealTimers();
});

describe("gpuChanged", () => {
  it("ignores moves of 64 MiB or less and catches larger ones", () => {
    expect(gpuChanged(status(9000), status(9064))).toBe(false);
    expect(gpuChanged(status(9000), status(9065))).toBe(true);
    expect(gpuChanged(status(9000), status(9000, 2300))).toBe(true);
    expect(gpuChanged(status(9000), { ...status(9000), occupants: [] })).toBe(true);
  });

  it("without a GPU, follows system memory", () => {
    expect(gpuChanged(noGpu(8000 * MIB), noGpu(8030 * MIB))).toBe(false);
    expect(gpuChanged(noGpu(8000 * MIB), noGpu(8100 * MIB))).toBe(true);
  });
});

describe("gpu watcher", () => {
  it("polls every 3 s only while a client is connected and pushes only real changes", async () => {
    vi.useFakeTimers();
    let free = 9000;
    let reads = 0;
    const pushed: number[] = [];
    const w = createGpuWatcher({
      read: async () => {
        reads++;
        return status(free);
      },
      push: (s) => pushed.push((s.freeBytes ?? 0) / MIB),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toBe(0);

    w.clientsChanged(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(reads).toBe(1);
    expect(pushed).toEqual([9000]);
    free = 9040;
    await vi.advanceTimersByTimeAsync(3000);
    expect(reads).toBe(2);
    expect(pushed).toEqual([9000]);
    free = 8000;
    await vi.advanceTimersByTimeAsync(3000);
    expect(pushed).toEqual([9000, 8000]);

    w.clientsChanged(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads).toBe(3);
    w.stop();
  });

  it("poke reads once even with no client connected", async () => {
    let reads = 0;
    const w = createGpuWatcher({
      read: async () => {
        reads++;
        return status(9000);
      },
      push: () => undefined,
    });
    w.poke();
    await vi.waitFor(() => expect(reads).toBe(1));
    expect(w.current()?.freeBytes).toBe(9000 * MIB);
    w.stop();
  });
});
