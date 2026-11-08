// Estimates what a model needs at a given num_ctx: weights + KV cache + a
// stated runtime overhead. The estimate is replaced by a measured report
// from /api/ps after a real load.
//
// KV cache per layer = head_count_kv * (key_length + value_length) * tokens
// * bytes per element. Per-layer head_count_kv arrays (gemma4, qwen35)
// carry 0 for layers with no KV (recurrent/SSM layers); a scalar
// head_count_kv with full_attention_interval N counts one layer in N.
// Sliding-window layers keep min(num_ctx, window + one batch) tokens with
// their *_swa key/value lengths. Recurrent state of hybrid models (a few
// MiB) sits inside the overhead.
import { KV_BYTES_PER_ELEMENT, RUNTIME_OVERHEAD_BYTES, SWA_BATCH_TOKENS, UNREPORTED_MAX_CONTEXT } from "./constants.ts";
import { FitError, type NeedEstimate } from "./types.ts";

export interface ArchInfo {
  architecture: string;
  blockCount: number;
  /** The most the model takes; absent when /api/show does not say. */
  contextLength?: number;
  /** One entry per layer. */
  headCountKv: number[];
  keyLength: number;
  valueLength: number;
  keyLengthSwa?: number;
  valueLengthSwa?: number;
  slidingWindow?: number;
  /** true where the layer uses the sliding window. */
  swaPattern?: boolean[];
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.map(num);
  return out.every((v) => v !== undefined) ? (out as number[]) : undefined;
}

/** Reads the attention geometry out of /api/show's model_info. */
export function parseArchInfo(model: string, modelInfo: Readonly<Record<string, unknown>> | undefined): ArchInfo {
  const info = modelInfo ?? {};
  const arch = info["general.architecture"];
  if (typeof arch !== "string" || arch === "") {
    throw new FitError("model-info-incomplete", `${model}: /api/show has no general.architecture`);
  }
  const get = (key: string) => info[`${arch}.${key}`];
  const blockCount = num(get("block_count"));
  const contextLength = num(get("context_length"));
  const headCount = num(get("attention.head_count")) ?? numArray(get("attention.head_count"))?.[0];
  const embedding = num(get("embedding_length"));
  if (blockCount === undefined) {
    throw new FitError("model-info-incomplete", `${model}: /api/show lacks ${arch}.block_count`);
  }

  const kvRaw = get("attention.head_count_kv");
  let headCountKv: number[];
  const kvList = numArray(kvRaw);
  if (kvList) {
    headCountKv = Array.from({ length: blockCount }, (_, i) => kvList[i] ?? 0);
  } else {
    const scalar = num(kvRaw) ?? headCount;
    if (scalar === undefined) {
      throw new FitError("model-info-incomplete", `${model}: /api/show lacks ${arch}.attention.head_count_kv and head_count`);
    }
    const interval = num(get("full_attention_interval"));
    headCountKv = Array.from({ length: blockCount }, (_, i) =>
      interval !== undefined && interval > 1 && (i + 1) % interval !== 0 ? 0 : scalar,
    );
  }

  const derivedHeadDim = embedding !== undefined && headCount ? embedding / headCount : undefined;
  const keyLength = num(get("attention.key_length")) ?? derivedHeadDim;
  const valueLength = num(get("attention.value_length")) ?? keyLength;
  if (keyLength === undefined || valueLength === undefined) {
    throw new FitError("model-info-incomplete", `${model}: /api/show gives no key_length and no embedding_length/head_count to derive it`);
  }

  const slidingWindow = num(get("attention.sliding_window"));
  const patternRaw = get("attention.sliding_window_pattern");
  const swaPattern = Array.isArray(patternRaw) ? patternRaw.map((v) => v === true) : undefined;
  const keyLengthSwa = num(get("attention.key_length_swa"));
  const valueLengthSwa = num(get("attention.value_length_swa"));

  return {
    architecture: arch,
    blockCount,
    ...(contextLength === undefined ? {} : { contextLength }),
    headCountKv,
    keyLength,
    valueLength,
    ...(keyLengthSwa === undefined ? {} : { keyLengthSwa }),
    ...(valueLengthSwa === undefined ? {} : { valueLengthSwa }),
    ...(slidingWindow === undefined ? {} : { slidingWindow }),
    ...(swaPattern === undefined ? {} : { swaPattern }),
  };
}

export interface KvEstimate {
  bytes: number;
  layers: number;
}

export function estimateKvCache(arch: ArchInfo, numCtx: number, bytesPerElement = KV_BYTES_PER_ELEMENT): KvEstimate {
  let bytes = 0;
  let layers = 0;
  for (let i = 0; i < arch.blockCount; i++) {
    const heads = arch.headCountKv[i] ?? 0;
    if (heads <= 0) continue;
    layers++;
    const swa = arch.slidingWindow !== undefined && arch.swaPattern?.[i] === true;
    const k = swa ? (arch.keyLengthSwa ?? arch.keyLength) : arch.keyLength;
    const v = swa ? (arch.valueLengthSwa ?? arch.valueLength) : arch.valueLength;
    const tokens = swa ? Math.min(numCtx, (arch.slidingWindow ?? 0) + SWA_BATCH_TOKENS) : numCtx;
    bytes += heads * (k + v) * tokens * bytesPerElement;
  }
  return { bytes, layers };
}

/** The most this model takes, from /api/show's model_info; undefined when it does not say. */
export function reportedContextLength(modelInfo: Readonly<Record<string, unknown>> | undefined): number | undefined {
  const arch = modelInfo?.["general.architecture"];
  if (typeof arch !== "string" || arch === "") return undefined;
  const length = modelInfo?.[`${arch}.context_length`];
  return typeof length === "number" && Number.isInteger(length) && length > 0 ? length : undefined;
}

/**
 * The context a model actually runs at: what was asked for, never past what
 * it takes. A model that does not say gets the safe fallback.
 */
export function effectiveNumCtx(requested: number, contextLength: number | undefined): number {
  return Math.min(requested, contextLength ?? UNREPORTED_MAX_CONTEXT);
}

export interface EstimateOptions {
  overheadBytes?: number;
  kvBytesPerElement?: number;
}

export function estimateNeed(
  model: string,
  numCtx: number,
  weightsBytes: number,
  arch: ArchInfo,
  options: EstimateOptions = {},
): NeedEstimate {
  const kv = estimateKvCache(arch, numCtx, options.kvBytesPerElement);
  const overheadBytes = options.overheadBytes ?? RUNTIME_OVERHEAD_BYTES;
  return {
    model,
    numCtx,
    weightsBytes,
    kvCacheBytes: kv.bytes,
    overheadBytes,
    totalBytes: weightsBytes + kv.bytes + overheadBytes,
    ...(arch.contextLength === undefined ? {} : { contextLength: arch.contextLength }),
    kvLayers: kv.layers,
  };
}
