
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
  busyPorts?: readonly string[];
  noAppCopy?: boolean;
  modelsDir?: string;
  holdsOne?: boolean;
  failure?: "download" | "checksum" | "disk" | "install" | "start";
  install?: { receivedBytes: number; totalBytes: number; bytesPerSecond?: number; stalled?: true };
};

export type ModelInfo = {
  name: string;
  digest: string;
  sizeBytes: number;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  modifiedAt: string;
  capabilities: readonly string[];
  maxContext?: number;
  pick?: { numCtx: number; verdict?: "fits" | "spills" | "refuse" };
};

export type LoadedModel = {
  name: string;
  sizeBytes: number;
  sizeVramBytes: number;
  expiresAt?: string;
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
