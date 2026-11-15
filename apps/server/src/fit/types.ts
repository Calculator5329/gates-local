import type { FitReport as WireFitReport, FitWords } from "@gates-local/contracts";

export type FitVerdict = "fits" | "spills" | "refuse";

export interface FitReport {
  model: string;
  numCtx: number;
  freeVramBytes: number;
  needVramBytes: number;
  spillRamBytes: number;
  verdict: FitVerdict;
  shortfallBytes?: number;
  source: "measured" | "estimate";
  measuredAt: number;
  message?: string;
  memAvailableBytes?: number;
  words?: FitWords;
}

type OnWire = FitReport extends WireFitReport ? true : never;
// why: a compile-time check that a FitReport goes on the wire as it is.
export const FIT_REPORT_ON_WIRE: OnWire = true;

export type TenantRole = "whisper" | "ollama" | "occupant";

export interface GpuTenant {
  pid: number;
  label: string;
  unnamed?: true;
  system?: true;
  processName: string;
  // external: nvidia-smi reports [N/A] in place of the memory of a process it cannot read.
  usedBytes?: number;
  role: TenantRole;
  permanent: boolean;
}

export interface GpuCard {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
}

export interface GpuSnapshot {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  gpuCount: number;
  cards?: readonly GpuCard[];
  unavailableDetail?: string;
  tenants: GpuTenant[];
  measuredAt: number;
}

export interface NeedEstimate {
  model: string;
  numCtx: number;
  weightsBytes: number;
  kvCacheBytes: number;
  overheadBytes: number;
  totalBytes: number;
  contextLength?: number;
  kvLayers: number;
}

export type FitErrorCode =
  | "gpu-unreadable"
  | "meminfo-unreadable"
  | "runtime-unreachable"
  | "runtime-bad-response"
  | "model-not-found"
  | "model-info-incomplete"
  | "not-loaded";

export class FitError extends Error {
  readonly code: FitErrorCode;
  constructor(code: FitErrorCode, message: string) {
    super(message);
    this.name = "FitError";
    this.code = code;
  }
}

// why: the signal kills the child, so a fit that is called off never waits on it.
export type NvidiaSmiRunner = (args: readonly string[], signal?: AbortSignal) => Promise<string>;
export type MeminfoReader = (signal?: AbortSignal) => Promise<string>;
