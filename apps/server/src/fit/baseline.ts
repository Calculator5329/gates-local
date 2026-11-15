import type { FitMemory } from "@gates-local/contracts";
import { MIB } from "./constants.ts";
import type { GpuSnapshot, GpuTenant } from "./types.ts";

// why: less than this above the baseline is noise, not a program to name.
export const OTHERS_MIN_BYTES = 512 * MIB;

export type GpuOthers = NonNullable<Extract<FitMemory, { kind: "gpu" }>["others"]>;

export interface GpuBaseline {
  observe(gpu: GpuSnapshot, ownComfyPids?: readonly number[]): void;
  others(gpu: GpuSnapshot, ownComfyPids?: readonly number[]): GpuOthers | undefined;
}

const bytesOf = (t: GpuTenant) => t.usedBytes ?? 0;
const sum = (ts: readonly GpuTenant[]) => ts.reduce((n, t) => n + bytesOf(t), 0);
// external: Ollama unloads an idle model to make room, so what its runners hold is never part of what is held for good.
const runners = (gpu: GpuSnapshot) => gpu.tenants.filter((t) => t.role === "ollama");

export function createGpuBaseline(): GpuBaseline {
  let least: { bytes: number; by: ReadonlyMap<string, number> } | undefined;

  return {
    observe(gpu, own = []) {
      // external: nvidia-smi gives the totals and the process list in two runs, so a process that started or grew between them is listed with more than the card says is used.
      const grewBetweenRuns = sum(gpu.tenants) > gpu.usedBytes;
      // why: a reading taken while a process grew would set the baseline too low for good.
      if (gpu.gpuCount === 0 || grewBetweenRuns) return;
      const mine = gpu.tenants.filter((t) => own.includes(t.pid));
      const held = Math.max(0, gpu.usedBytes - sum(runners(gpu)) - sum(mine));
      if (least !== undefined && held >= least.bytes) return;
      const by = new Map<string, number>();
      for (const t of gpu.tenants) if (t.role !== "ollama" && !own.includes(t.pid)) by.set(t.processName, (by.get(t.processName) ?? 0) + bytesOf(t));
      least = { bytes: held, by };
    },
    others(gpu, own = []) {
      if (gpu.gpuCount === 0 || least === undefined) return undefined;
      // why: this app's ComfyUI is not another program: a load stops it when it is idle.
      const bytes = gpu.usedBytes - sum(runners(gpu)) - sum(gpu.tenants.filter((t) => own.includes(t.pid))) - least.bytes;
      if (bytes < OTHERS_MIN_BYTES) return undefined;
      const programs: string[] = [];
      for (const t of gpu.tenants) {
        const aboveItsShare = bytesOf(t) - (least.by.get(t.processName) ?? 0);
        if (t.role === "ollama" || own.includes(t.pid) || aboveItsShare < OTHERS_MIN_BYTES) continue;
        const name = /comfy/i.test(t.processName) ? "ComfyUI" : t.label;
        if (!programs.includes(name)) programs.push(name);
      }
      return { programs, bytes };
    },
  };
}
