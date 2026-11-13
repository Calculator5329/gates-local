// The card, and who is using it right now. The owner's ruling (2026-11-13): "the measure for a
// model is not what is available now its based on the ram in the card". Every list and Settings
// judge a model against the card's own memory; what other programs hold right now is shown beside
// it, never as the verdict. A send still judges right now (fit.ts), since that load happens now.
//
// Who to name: the steady baseline is the least GPU memory seen held by everything that is neither
// a model runtime's runner (Ollama unloads an idle model to make room) nor this app's own ComfyUI
// (a load may stop it): the desktop, whisper and the other always-on services. It is learned from
// the readings this process takes, so it starts at the first reading and only goes down. A program
// well above its share of it is the one the Download tab names.
import type { FitMemory } from "@gates-local/contracts";
import { MIB } from "./constants.ts";
import type { GpuSnapshot, GpuTenant } from "./types.ts";

/** Less than this above the baseline is noise, not a program to name. */
export const OTHERS_MIN_BYTES = 512 * MIB;

export type GpuOthers = NonNullable<Extract<FitMemory, { kind: "gpu" }>["others"]>;

export interface GpuBaseline {
  /** Learns from one reading; `own` names this app's processes (its ComfyUI), never counted as other programs. */
  observe(gpu: GpuSnapshot, own?: readonly number[]): void;
  /** The memory a model is judged against: the card's own, whatever other programs hold. */
  cardFree(gpu: GpuSnapshot): number;
  /** The programs holding memory above the baseline right now, and how much; undefined when none do. */
  others(gpu: GpuSnapshot, own?: readonly number[]): GpuOthers | undefined;
}

const bytesOf = (t: GpuTenant) => t.usedBytes ?? 0;
const sum = (ts: readonly GpuTenant[]) => ts.reduce((n, t) => n + bytesOf(t), 0);
const runners = (gpu: GpuSnapshot) => gpu.tenants.filter((t) => t.role === "ollama");

export function createGpuBaseline(): GpuBaseline {
  /** The least memory held outside the runners and this app's ComfyUI, and who held it then. */
  let least: { bytes: number; by: ReadonlyMap<string, number> } | undefined;

  return {
    observe(gpu, own = []) {
      // The totals and the process list are two nvidia-smi runs: a process listed with more than the
      // card says is used started or grew between them, and would set the baseline too low for good.
      if (gpu.gpuCount === 0 || sum(gpu.tenants) > gpu.usedBytes) return;
      const mine = gpu.tenants.filter((t) => own.includes(t.pid));
      const held = Math.max(0, gpu.usedBytes - sum(runners(gpu)) - sum(mine));
      if (least !== undefined && held >= least.bytes) return;
      const by = new Map<string, number>();
      for (const t of gpu.tenants) if (t.role !== "ollama" && !own.includes(t.pid)) by.set(t.processName, (by.get(t.processName) ?? 0) + bytesOf(t));
      least = { bytes: held, by };
    },
    cardFree(gpu) {
      return gpu.gpuCount === 0 ? gpu.freeBytes : Math.max(gpu.freeBytes, gpu.totalBytes);
    },
    others(gpu, own = []) {
      if (gpu.gpuCount === 0 || least === undefined) return undefined;
      // This app's ComfyUI is not another program: a load stops it when it is idle.
      const bytes = gpu.usedBytes - sum(runners(gpu)) - sum(gpu.tenants.filter((t) => own.includes(t.pid))) - least.bytes;
      if (bytes < OTHERS_MIN_BYTES) return undefined;
      const programs: string[] = [];
      for (const t of gpu.tenants) {
        if (t.role === "ollama" || own.includes(t.pid) || bytesOf(t) - (least.by.get(t.processName) ?? 0) < OTHERS_MIN_BYTES) continue;
        const name = /comfy/i.test(t.processName) ? "ComfyUI" : t.label;
        if (!programs.includes(name)) programs.push(name);
      }
      return { programs, bytes };
    },
  };
}
