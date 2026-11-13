// The curated models: friendly name, a purpose phrase of four words or fewer
// (the same phrase on every surface, docs/design/shell.md "Words used
// everywhere" and F62) and the download size.
//
// The list holds only models anyone can download with `ollama pull`. A model
// the user installed under any other name still shows, as their own.
//
// downloadBytes is the sum of layer and config sizes in registry.ollama.ai's
// manifest, read 2026-11-07. An installed model's catalog entry uses its own
// /api/tags size instead.
//
// Two departures from the design's example list, both because the design's
// tags do not exist in the registry (404 on 2026-11-07): "Qwen 3.5 14B"
// (qwen3.5:14b) is Qwen 3 14B (qwen3:14b) and "Qwen 3.5 VL 9B"
// (qwen3.5-vl:9b) is Qwen 3 VL 8B (qwen3-vl:8b). Two phrases were five
// words and are cut to four: "Stronger answers on GPU", "Reads images you
// attach". The first became "Stronger all-round answers" on 2026-11-13: a
// phrase about the GPU must not show on a computer without one (row 21).

export interface CuratedModel {
  /** The Ollama tag. */
  readonly name: string;
  readonly label: string;
  readonly purpose: string;
  readonly downloadBytes: number;
  /** False for a local name that `ollama pull` cannot fetch; such an entry lists only when installed. */
  readonly pullable: boolean;
}

export const CURATED_MODELS: readonly CuratedModel[] = [
  { name: "qwen3.5:9b", label: "Qwen 3.5 9B", purpose: "Fast everyday answers", downloadBytes: 6_550_825_550, pullable: true },
  { name: "gemma4:12b", label: "Gemma 4 12B", purpose: "Careful longer answers", downloadBytes: 8_021_618_941, pullable: true },
  { name: "gpt-oss:20b", label: "gpt-oss 20B", purpose: "Step-by-step reasoning", downloadBytes: 13_793_441_566, pullable: true },
  { name: "qwen3:14b", label: "Qwen 3 14B", purpose: "Stronger all-round answers", downloadBytes: 9_276_198_565, pullable: true },
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
