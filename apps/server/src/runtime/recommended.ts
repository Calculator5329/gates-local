// The curated models: friendly name, a purpose phrase of four words or fewer
// (the same phrase on every surface, docs/design/shell.md "Words used
// everywhere" and F62) and the download size.
//
// downloadBytes for pullable models is the sum of layer and config sizes in
// registry.ollama.ai's manifest, read 2026-11-07; for local-only models it is
// the size /api/tags reported on the build machine that day. An installed
// model's catalog entry uses its own /api/tags size instead.
//
// Two departures from the design's example list, both because the design's
// tags do not exist in the registry (404 on 2026-11-07): "Qwen 3.5 14B"
// (qwen3.5:14b) is Qwen 3 14B (qwen3:14b) and "Qwen 3.5 VL 9B"
// (qwen3.5-vl:9b) is Qwen 3 VL 8B (qwen3-vl:8b). Two phrases were five
// words and are cut to four: "Stronger answers on GPU", "Reads images you
// attach".

export interface CuratedModel {
  /** The Ollama tag. */
  readonly name: string;
  readonly label: string;
  readonly purpose: string;
  readonly downloadBytes: number;
  /** False for local names (abliterated builds copied under a short tag) that `ollama pull` cannot fetch. */
  readonly pullable: boolean;
}

export const CURATED_MODELS: readonly CuratedModel[] = [
  { name: "qwen3.5:9b", label: "Qwen 3.5 9B", purpose: "Fast everyday answers", downloadBytes: 6_550_825_550, pullable: true },
  { name: "gemma4:12b", label: "Gemma 4 12B", purpose: "Careful longer answers", downloadBytes: 8_021_618_941, pullable: true },
  { name: "gemma3-abliterated:12b-q4", label: "Gemma 3 12B abliterated", purpose: "Fewer refusals", downloadBytes: 8_154_980_034, pullable: false },
  { name: "gpt-oss:20b", label: "gpt-oss 20B", purpose: "Step-by-step reasoning", downloadBytes: 13_793_441_566, pullable: true },
  { name: "gemma4-abliterated:26b", label: "Gemma 4 26B abliterated", purpose: "Fewer refusals, stronger", downloadBytes: 17_990_843_601, pullable: false },
  { name: "qwen3.8-abliterated:27b", label: "Qwen 3.8 27B abliterated", purpose: "Fewer refusals, strongest", downloadBytes: 13_210_122_027, pullable: false },
  { name: "qwen3:14b", label: "Qwen 3 14B", purpose: "Stronger answers on GPU", downloadBytes: 9_276_198_565, pullable: true },
  { name: "qwen3.5:4b", label: "Qwen 3.5 4B", purpose: "Fastest replies, lighter answers", downloadBytes: 3_324_173_934, pullable: true },
  { name: "qwen3-vl:8b", label: "Qwen 3 VL 8B", purpose: "Reads images you attach", downloadBytes: 6_190_971_699, pullable: true },
  { name: "mistral-small3.2:24b", label: "Mistral Small 3.2 24B", purpose: "Careful writer", downloadBytes: 15_177_384_862, pullable: true },
];

/** The purpose shown for an installed model the app does not curate. */
export const OWN_MODEL_PURPOSE = "Installed by you";

/** Ollama names carry an implicit ":latest". */
export const canonicalTag = (name: string) => (name.includes(":") ? name : `${name}:latest`);

export function curated(name: string): CuratedModel | undefined {
  const tag = canonicalTag(name);
  return CURATED_MODELS.find((m) => m.name === tag);
}

/** The friendly name for a tag: the curated label, else the tag without ":latest" or its hf.co path. */
export function modelLabel(name: string): string {
  const known = curated(name);
  if (known) return known.label;
  const short = name.replace(/:latest$/, "");
  return short.startsWith("hf.co/") ? (short.split("/").pop() ?? short) : short;
}
