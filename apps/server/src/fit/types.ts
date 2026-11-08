// Plain shapes for the fit check. FitReport mirrors the shared shape that
// packages/contracts carries as a Schema; `message` is an addition (the
// human sentence that names the numbers).

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
  /** Set when the refusal is the model's own context ceiling: the most it supports. */
  contextLimit?: number;
}

/** Who holds GPU memory. Whisper is the permanent tenant the fit plans around. */
export type TenantRole = "whisper" | "ollama" | "occupant";

export interface GpuTenant {
  pid: number;
  /** Short name for display, e.g. "whisper-server", "media-vault vision runtime". */
  label: string;
  /** The raw process_name from nvidia-smi. */
  processName: string;
  /** undefined when nvidia-smi reports [N/A]. */
  usedBytes?: number;
  role: TenantRole;
  /** True for whisper: never stopped, evicted, restarted or reconfigured. */
  permanent: boolean;
}

export interface GpuSnapshot {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  /** Number of GPUs nvidia-smi listed; the fit uses the first. */
  gpuCount: number;
  tenants: GpuTenant[];
  measuredAt: number;
}

/** Breakdown of an estimated need, so the UI can show where the bytes go. */
export interface NeedEstimate {
  model: string;
  numCtx: number;
  weightsBytes: number;
  kvCacheBytes: number;
  overheadBytes: number;
  totalBytes: number;
  contextLength: number;
  /** Layers that carry a KV cache (hybrid and sliding-window models have fewer). */
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

/** Runs nvidia-smi with the given args and resolves its stdout. */
export type NvidiaSmiRunner = (args: readonly string[]) => Promise<string>;
/** Resolves the text of /proc/meminfo. */
export type MeminfoReader = () => Promise<string>;
