// The part of a model file that stays in system memory whatever the card holds. gemma4's small
// files (E2B, E4B) carry a per-layer input table, per_layer_token_embd: one row per vocabulary
// entry, 256 values per layer. The runtime keeps input tables on the processor, so on a card it
// takes none of the card's memory, and it is about half of those files (1.93 GB of the E2B's 4.59 GB).
// Its size needs the vocabulary and the tensor's type, which only a verbose /api/show gives, so that
// answer is asked once per model file and only for a file whose plain answer names the table.
import { fetchTensors, type TensorsResponse } from "./ollama.ts";

/** The name of the table the runtime keeps off the card. */
export const PER_LAYER_TABLE = "per_layer_token_embd.weight";

/** Bytes per block and values per block of each ggml type a weight is stored in. */
const BLOCKS: Readonly<Record<string, readonly [bytes: number, values: number]>> = {
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

/** The bytes a tensor of this type and shape takes; undefined for a type this table does not know. */
export function tensorBytes(type: string, shape: readonly number[]): number | undefined {
  const block = BLOCKS[type.toUpperCase()];
  if (block === undefined || shape.length === 0) return undefined;
  const values = shape.reduce((a, b) => a * b, 1);
  return Math.ceil(values / block[1]) * block[0];
}

/** True when /api/show's plain answer says the file has a per-layer input table. */
export function hasPerLayerTable(modelInfo: Readonly<Record<string, unknown>> | undefined): boolean {
  const arch = modelInfo?.["general.architecture"];
  if (typeof arch !== "string") return false;
  const width = modelInfo?.[`${arch}.embedding_length_per_layer_input`];
  return typeof width === "number" && width > 0;
}

/** The table's bytes from a verbose answer; undefined when it is absent or of an unknown type. */
export function offCardBytesOf(tensors: TensorsResponse): number | undefined {
  const table = tensors.tensors?.find((t) => t.name === PER_LAYER_TABLE);
  return table === undefined ? undefined : tensorBytes(table.type, table.shape);
}

// One verbose answer per runtime and model file, for the server's life; a failed one is not kept.
const asked = new Map<string, Promise<number | undefined>>();

/**
 * The bytes of `model`'s per-layer table, which the card does not hold. `file` names the model file
 * (its digest); undefined when the runtime does not say, and the whole file then counts as before.
 */
export function offCardBytes(baseUrl: string, model: string, file: string, signal?: AbortSignal): Promise<number | undefined> {
  const key = `${baseUrl} ${file}`;
  let bytes = asked.get(key);
  if (bytes === undefined) {
    bytes = fetchTensors(baseUrl, model, signal).then(offCardBytesOf);
    asked.set(key, bytes);
    bytes.catch(() => asked.delete(key));
  }
  return bytes.catch(() => undefined);
}
