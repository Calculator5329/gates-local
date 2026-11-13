// The curated models: friendly name, a purpose phrase of four words or fewer
// (the same phrase on every surface, docs/design/shell.md "Words used
// everywhere" and F62) and the download size. The list itself is data:
// packages/contracts/src/chat-models.json, which says how each field is read.
//
// The list holds only models anyone can download with `ollama pull`. A model
// the user installed under any other name still shows, as their own.
import { CHAT_MODELS } from "@gates-local/contracts";

export interface CuratedModel {
  /** The Ollama tag. */
  readonly name: string;
  readonly label: string;
  readonly purpose: string;
  readonly downloadBytes: number;
  /** False for a local name that `ollama pull` cannot fetch; such an entry lists only when installed. */
  readonly pullable: boolean;
}

/** In the data file's order, which is the rank a chat model is picked by (pick.ts). */
export const CURATED_MODELS: readonly CuratedModel[] = CHAT_MODELS.models.map((m) => ({ ...m, pullable: true }));

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
