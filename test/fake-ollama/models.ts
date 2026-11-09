// The models the fake Ollama knows. Sizes and architecture are examples
// chosen so the server's fit check gives every verdict on the fixture GPU
// (16303 MiB, whisper and one other app resident): the 9B runs on the GPU at
// 16k and 32k and spills at 64k, the 12B spills at 32k, the 27B never fits.

const GIB = 1024 ** 3;

/** The long-name scenario's extra model: a tag long enough to crowd the composer. */
export const LONG_NAME = "gemma-4-26B-A4B-it-ultra-uncensored-heretic-GGUF:Q4_K_M";

export interface FakeModel {
  readonly name: string;
  readonly family: string;
  readonly parameterSize: string;
  readonly parameterCount: number;
  readonly quantization: string;
  readonly sizeBytes: number;
  readonly digest: string;
  readonly capabilities: readonly string[];
  readonly blockCount: number;
  readonly headCount: number;
  readonly headCountKv: number;
  readonly keyLength: number;
  /** undefined: /api/show reports no maximum. */
  readonly contextLength: number | undefined;
}

function model(m: Omit<FakeModel, "digest">): FakeModel {
  // A stable fake digest: the tag's char codes, hex, padded to 64.
  const hex = [...m.name].map((c) => c.charCodeAt(0).toString(16)).join("");
  return { ...m, digest: hex.padEnd(64, "0").slice(0, 64) };
}

export const FAKE_MODELS: readonly FakeModel[] = [
  // Hosted quantization pair for picker identity checks; geometry is an offline example.
  ...["Q4_K_M", "Q8_0"].map(quantization => model({
    name: `hf.co/llmfan46/gemma-4-26B-A4B-it-ultra-uncensored-heretic-GGUF:${quantization}`,
    family: "gemma4", parameterSize: "25.8B", parameterCount: 25_800_000_000,
    quantization, sizeBytes: Math.round(7.9 * GIB), capabilities: ["completion", "tools"],
    blockCount: 40, headCount: 32, headCountKv: 8, keyLength: 128, contextLength: 131_072,
  })),
  // Opt-in vision fixture that fits the measured fake GPU at the default context.
  model({
    name: "qwen3-vl:8b",
    family: "qwen3vl",
    parameterSize: "8.8B",
    parameterCount: 8_800_000_000,
    quantization: "Q4_K_M",
    sizeBytes: Math.round(6 * GIB),
    capabilities: ["completion", "vision"],
    blockCount: 32,
    headCount: 32,
    headCountKv: 8,
    keyLength: 128,
    contextLength: 131_072,
  }),
  model({
    name: "qwen3.5:9b",
    family: "qwen35",
    parameterSize: "9.7B",
    parameterCount: 9_653_104_368,
    quantization: "Q4_K_M",
    sizeBytes: Math.round(6.6 * GIB),
    capabilities: ["completion", "thinking", "tools"],
    blockCount: 32,
    headCount: 32,
    headCountKv: 6,
    keyLength: 128,
    contextLength: 262_144,
  }),
  model({
    name: "gemma4:12b",
    family: "gemma4",
    parameterSize: "12.2B",
    parameterCount: 12_187_000_000,
    quantization: "Q4_K_M",
    sizeBytes: Math.round(7.6 * GIB),
    capabilities: ["completion", "tools"],
    blockCount: 40,
    headCount: 32,
    headCountKv: 8,
    keyLength: 128,
    contextLength: 131_072,
  }),
  model({
    name: "qwen3.8-abliterated:27b",
    family: "qwen38",
    parameterSize: "27.4B",
    parameterCount: 27_400_000_000,
    quantization: "Q4_K_M",
    sizeBytes: Math.round(17.4 * GIB),
    capabilities: ["completion", "thinking"],
    blockCount: 64,
    headCount: 40,
    headCountKv: 8,
    keyLength: 128,
    contextLength: 131_072,
  }),
  model({
    name: "qwen3.5:4b",
    family: "qwen35",
    parameterSize: "4.2B",
    parameterCount: 4_200_000_000,
    quantization: "Q4_K_M",
    sizeBytes: Math.round(3.4 * GIB),
    capabilities: ["completion", "thinking", "tools"],
    blockCount: 28,
    headCount: 16,
    headCountKv: 4,
    keyLength: 128,
    contextLength: 262_144,
  }),
  // An embedding model, the smallest when installed (the embed-smallest
  // scenario): it must never be offered as a chat model. Real tag and
  // size; geometry from nomic-bert's /api/show.
  model({
    name: "nomic-embed-text:latest",
    family: "nomic-bert",
    parameterSize: "137M",
    parameterCount: 136_727_040,
    quantization: "F16",
    sizeBytes: 274_302_450,
    capabilities: ["embedding"],
    blockCount: 12,
    headCount: 12,
    headCountKv: 12,
    keyLength: 64,
    contextLength: 2048,
  }),
  // The long-name scenario: a real Hugging Face GGUF tag of this length.
  // Sized like the 12B so it can be picked; the test is about the name's
  // length, not the fit.
  model({
    name: LONG_NAME,
    family: "gemma4",
    parameterSize: "25.8B",
    parameterCount: 25_800_000_000,
    quantization: "Q4_K_M",
    sizeBytes: Math.round(7.9 * GIB),
    capabilities: ["completion", "tools"],
    blockCount: 40,
    headCount: 32,
    headCountKv: 8,
    keyLength: 128,
    contextLength: 131_072,
  }),
  // Not installed by default: the README shots install it as a model too big for the fixture GPU at 16k.
  model({
    name: "mistral-small3.2:24b",
    family: "mistral3",
    parameterSize: "24.0B",
    parameterCount: 24_011_361_280,
    quantization: "Q4_K_M",
    sizeBytes: Math.round(14.1 * GIB),
    capabilities: ["completion", "tools", "vision"],
    blockCount: 40,
    headCount: 32,
    headCountKv: 8,
    keyLength: 128,
    contextLength: 131_072,
  }),
  // Not installed by default: takes the picker's 8k, 16k and 32k but not 64k.
  model({
    name: "mid-chat:32k",
    family: "tiny",
    parameterSize: "1.0B",
    parameterCount: 1_000_000_000,
    quantization: "Q4_K_M",
    sizeBytes: Math.round(0.8 * GIB),
    capabilities: ["completion"],
    blockCount: 12,
    headCount: 8,
    headCountKv: 8,
    keyLength: 64,
    contextLength: 32_768,
  }),
  // Not installed by default: ids that clean up to the same name, two by quant and two by owner.
  ...["local/model:9b-q4_K_M", "local/model:9b-q8_0", "alice/custom:latest", "bob/custom:latest"].map((name) =>
    model({
      name,
      family: "tiny",
      parameterSize: "500M",
      parameterCount: 500_000_000,
      quantization: "Q4_K_M",
      sizeBytes: Math.round(0.4 * GIB),
      capabilities: ["completion"],
      blockCount: 12,
      headCount: 8,
      headCountKv: 8,
      keyLength: 64,
      contextLength: 32_768,
    }),
  ),
  // Not installed by default: a chat model whose own window is 2,048 tokens, and one that reports no maximum.
  model({
    name: "tiny-chat:2k",
    family: "tiny",
    parameterSize: "500M",
    parameterCount: 500_000_000,
    quantization: "Q4_K_M",
    sizeBytes: Math.round(0.4 * GIB),
    capabilities: ["completion"],
    blockCount: 12,
    headCount: 8,
    headCountKv: 8,
    keyLength: 64,
    contextLength: 2048,
  }),
  model({
    name: "no-limit-chat:1b",
    family: "tiny",
    parameterSize: "1.0B",
    parameterCount: 1_000_000_000,
    quantization: "Q4_K_M",
    sizeBytes: Math.round(0.8 * GIB),
    capabilities: ["completion"],
    blockCount: 12,
    headCount: 8,
    headCountKv: 8,
    keyLength: 64,
    contextLength: undefined,
  }),
];

/** Installed when the scenario has models; qwen3.5:4b stays pullable. */
export const DEFAULT_INSTALLED = ["qwen3.5:9b", "gemma4:12b", "qwen3.8-abliterated:27b"] as const;

/** The embed-smallest scenario: the defaults plus an embedding model smaller than any of them. */
export const EMBED_SMALLEST_INSTALLED = [...DEFAULT_INSTALLED, "nomic-embed-text:latest"] as const;

/** The embed-only scenario: an embedding model and nothing that can chat (MP-04). */
export const EMBED_ONLY_INSTALLED = ["nomic-embed-text:latest"] as const;

/** The long-name scenario: the defaults plus a long Hugging Face tag. */
export const LONG_NAME_INSTALLED = [...DEFAULT_INSTALLED, LONG_NAME] as const;

export function findFakeModel(name: string): FakeModel | undefined {
  const full = name.includes(":") ? name : `${name}:latest`;
  return FAKE_MODELS.find((m) => m.name === full || m.name === name);
}

/** The /api/show body for a model, in the shape the server's fit check parses. */
export function showBody(m: FakeModel): Record<string, unknown> {
  const arch = "llama";
  return {
    details: { format: "gguf", family: m.family, families: [m.family], parameter_size: m.parameterSize, quantization_level: m.quantization },
    model_info: {
      "general.architecture": arch,
      "general.parameter_count": m.parameterCount,
      [`${arch}.block_count`]: m.blockCount,
      ...(m.contextLength === undefined ? {} : { [`${arch}.context_length`]: m.contextLength }),
      [`${arch}.embedding_length`]: m.headCount * m.keyLength,
      [`${arch}.attention.head_count`]: m.headCount,
      [`${arch}.attention.head_count_kv`]: m.headCountKv,
      [`${arch}.attention.key_length`]: m.keyLength,
      [`${arch}.attention.value_length`]: m.keyLength,
    },
    capabilities: m.capabilities,
  };
}
