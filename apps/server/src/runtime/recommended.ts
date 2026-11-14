// The curated models: friendly name, a purpose phrase of four words or fewer
// (the same phrase on every surface, docs/design/shell.md "Words used
// everywhere" and F62) and the download size. The list itself is data:
// packages/contracts/src/chat-models.json, which says how each field is read,
// or the newer signed list an installed copy downloaded (chat-list.ts).
//
// The list holds only models anyone can download with `ollama pull`. A model
// the user installed under any other name still shows, as their own.
import type { ChatModels } from "@gates-local/contracts";
import { chatList } from "./chat-list.ts";

export interface CuratedModel {
  /** The Ollama tag. */
  readonly name: string;
  readonly label: string;
  readonly purpose: string;
  readonly downloadBytes: number;
  /** False for a local name that `ollama pull` cannot fetch; such an entry lists only when installed. */
  readonly pullable: boolean;
}

const made = new WeakMap<ChatModels, readonly CuratedModel[]>();

/** The list in use, in its order, which is the rank a chat model is picked by (pick.ts). */
export function curatedModels(): readonly CuratedModel[] {
  const list = chatList();
  let models = made.get(list);
  if (models === undefined) {
    models = list.models.map((m) => ({ ...m, pullable: true }));
    made.set(list, models);
  }
  return models;
}

/** The purpose shown for an installed model the app does not curate. */
export const OWN_MODEL_PURPOSE = "Installed by you";

/** Ollama names carry an implicit ":latest". */
export const canonicalTag = (name: string) => (name.includes(":") ? name : `${name}:latest`);

export function curated(name: string): CuratedModel | undefined {
  const tag = canonicalTag(name);
  return curatedModels().find((m) => m.name === tag);
}

/** The friendly name for a tag: the curated label, else the tag without ":latest" or its hf.co path. */
export function modelLabel(name: string): string {
  const known = curated(name);
  if (known) return known.label;
  const short = name.replace(/:latest$/, "");
  return short.startsWith("hf.co/") ? (short.split("/").pop() ?? short) : short;
}
