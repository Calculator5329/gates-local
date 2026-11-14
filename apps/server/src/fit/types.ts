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
}

/** Who holds GPU memory. Whisper is the permanent tenant the fit plans around. */
export type TenantRole = "whisper" | "ollama" | "occupant";

export interface GpuTenant {
  pid: number;
  /** The program's own name for display ("whisper-server", "Discord"): no folders, no flags, no ".exe". */
  label: string;
  /** nvidia-smi gave a bracketed note instead of a name ("[Insufficient Permissions]"). */
  unnamed?: true;
  /** A desktop process (the compositor, the Windows shell): never something to tell a person to close. */
  system?: true;
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
  /** Confirmed absence reported by nvidia-smi; absent when the executable is missing. */
  unavailableDetail?: string;
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
  contextLength?: number;
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

/**
 * Runs nvidia-smi with the given args and resolves its stdout. `signal`
 * (when given) kills the child: a fit that is called off never waits on it.
 */
export type NvidiaSmiRunner = (args: readonly string[], signal?: AbortSignal) => Promise<string>;
/** Resolves the text of /proc/meminfo; `signal` ends the read early. */
export type MeminfoReader = (signal?: AbortSignal) => Promise<string>;
