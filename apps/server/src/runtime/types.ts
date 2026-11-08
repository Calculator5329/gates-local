// Plain shapes shared inside the runtime module. The contracts package
// mirrors RuntimeStatus and ModelInfo as Schemas for the wire.

export type RuntimeState =
  | "ready"
  | "starting"
  | "installing"
  | "missing"
  | "stopped"
  | "wrong-service"
  | "error";

export type RuntimeOwner = "external" | "app" | "none";

export type RuntimeStatus = {
  state: RuntimeState;
  owner: RuntimeOwner;
  baseUrl: string;
  version?: string;
  detail?: string;
  /** Ports that something other than Ollama holds (contracts RuntimeStatus.busyPorts). */
  busyPorts?: readonly string[];
};

export type ModelInfo = {
  name: string;
  digest: string;
  sizeBytes: number;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  modifiedAt: string;
  /** Ollama's words from /api/show (contracts ModelInfo.capabilities). */
  capabilities: readonly string[];
  /** The most context this model takes (contracts ModelInfo.maxContext). */
  maxContext?: number;
  /** The model chat starts on (contracts ModelPick); set by the catalog's pick hook. */
  pick?: { numCtx: number; verdict?: "fits" | "spills" | "refuse" };
};

/** A model the runtime currently holds in memory (`/api/ps`). */
export type LoadedModel = {
  name: string;
  sizeBytes: number;
  sizeVramBytes: number;
  expiresAt?: string;
  /** /api/ps context_length: the num_ctx it is loaded at; undefined when Ollama does not say. */
  contextLength?: number;
};

export type InstallPhase = "download" | "verify" | "extract" | "done";

export type InstallProgress = {
  phase: InstallPhase;
  version: string;
  receivedBytes: number;
  totalBytes: number;
};

export type Listener<T> = (value: T) => void;
