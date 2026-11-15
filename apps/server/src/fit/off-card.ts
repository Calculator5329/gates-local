import { fetchTensors, type TensorsResponse } from "./ollama.ts";

// external: Ollama keeps a model's input tables on the processor, so this per-layer table of gemma4's small files (about half of an E2B or E4B file) takes none of the card's memory.
export const PER_LAYER_TABLE = "per_layer_token_embd.weight";

const GGML_BLOCKS: Readonly<Record<string, readonly [bytes: number, values: number]>> = {
  F32: [4, 1],
  F16: [2, 1],
  BF16: [2, 1],
  Q8_0: [34, 32],
  Q6_K: [210, 256],
  Q5_K: [176, 256],
  Q5_1: [24, 32],
  Q5_0: [22, 32],
  Q4_K: [144, 256],
  Q4_1: [20, 32],
  Q4_0: [18, 32],
  IQ4_XS: [136, 256],
  IQ4_NL: [18, 32],
  Q3_K: [110, 256],
  Q2_K: [84, 256],
};

export function tensorBytes(type: string, shape: readonly number[]): number | undefined {
  const block = GGML_BLOCKS[type.toUpperCase()];
  if (block === undefined || shape.length === 0) return undefined;
  const [bytesPerBlock, valuesPerBlock] = block;
  const values = shape.reduce((a, b) => a * b, 1);
  return Math.ceil(values / valuesPerBlock) * bytesPerBlock;
}

export function hasPerLayerTable(modelInfo: Readonly<Record<string, unknown>> | undefined): boolean {
  const arch = modelInfo?.["general.architecture"];
  if (typeof arch !== "string") return false;
  const width = modelInfo?.[`${arch}.embedding_length_per_layer_input`];
  return typeof width === "number" && width > 0;
}

export function offCardBytesOf(verboseShow: TensorsResponse): number | undefined {
  const table = verboseShow.tensors?.find((t) => t.name === PER_LAYER_TABLE);
  return table === undefined ? undefined : tensorBytes(table.type, table.shape);
}

// why: one verbose answer per runtime and model file, for the server's life.
const asked = new Map<string, Promise<number | undefined>>();

export function offCardBytes(baseUrl: string, model: string, fileDigest: string, signal?: AbortSignal): Promise<number | undefined> {
  const key = `${baseUrl} ${fileDigest}`;
  let bytes = asked.get(key);
  if (bytes === undefined) {
    bytes = fetchTensors(baseUrl, model, signal).then(offCardBytesOf);
    asked.set(key, bytes);
    // why: a failed answer is not kept, so the next call asks again.
    bytes.catch(() => asked.delete(key));
  }
  return bytes.catch(() => undefined);
}
