import type { GpuStatus } from "@gates-local/contracts";
import { MIB } from "./constants.ts";
import { forgetGpuReadings } from "./gpu.ts";

export const GPU_POLL_MS = 3000;
export const GPU_CHANGE_BYTES = 64 * MIB;

export interface GpuWatcher {
  current(): GpuStatus | undefined;
  read(): Promise<GpuStatus>;
  clientsChanged(count: number): void;
  poke(): void;
  stop(): void;
}

export interface GpuWatcherOptions {
  read: () => Promise<GpuStatus>;
  push: (status: GpuStatus) => void;
  intervalMs?: number;
  thresholdBytes?: number;
  log?: (line: string) => void;
}

const key = (o: GpuStatus["occupants"][number]) => `${o.kind}\0${o.label}`;

export function gpuChanged(prev: GpuStatus | undefined, next: GpuStatus, thresholdBytes = GPU_CHANGE_BYTES): boolean {
  if (prev === undefined) return true;
  if (prev.vendor !== next.vendor || prev.detail !== next.detail) return true;
  if (Math.abs((prev.freeBytes ?? 0) - (next.freeBytes ?? 0)) > thresholdBytes) return true;
  if (prev.occupants.length !== next.occupants.length) return true;
  const before = new Map(prev.occupants.map((o) => [key(o), o]));
  for (const o of next.occupants) {
    const p = before.get(key(o));
    if (p === undefined || p.protected !== o.protected || Math.abs(p.bytes - o.bytes) > thresholdBytes) return true;
  }
  // why: with no GPU, system memory is what models run in, so it is the number to follow.
  return next.vendor !== "nvidia" && Math.abs(prev.systemMemoryAvailableBytes - next.systemMemoryAvailableBytes) > thresholdBytes;
}

export function createGpuWatcher(options: GpuWatcherOptions): GpuWatcher {
  const intervalMs = options.intervalMs ?? GPU_POLL_MS;
  const threshold = options.thresholdBytes ?? GPU_CHANGE_BYTES;
  const log = options.log ?? (() => undefined);
  let last: GpuStatus | undefined;
  let pushed: GpuStatus | undefined;
  let clients = 0;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<GpuStatus> | undefined;
  let stopped = false;

  const read = (): Promise<GpuStatus> => {
    if (inFlight) return inFlight;
    inFlight = options
      .read()
      .then((status) => {
        last = status;
        if (gpuChanged(pushed, status, threshold)) {
          // why: memory moved, so the fit and the table read again instead of reusing a reading.
          forgetGpuReadings();
          pushed = status;
          options.push(status);
        }
        return status;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };

  const schedule = () => {
    if (stopped || clients === 0 || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      read()
        .catch((e: unknown) => log(`gpu read failed: ${(e as Error).message}`))
        .finally(schedule);
    }, intervalMs);
    timer.unref();
  };

  return {
    current: () => last,
    read,
    clientsChanged(count) {
      clients = count;
      if (clients === 0 && timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      schedule();
    },
    poke() {
      if (!stopped) read().catch((e: unknown) => log(`gpu read failed: ${(e as Error).message}`));
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
