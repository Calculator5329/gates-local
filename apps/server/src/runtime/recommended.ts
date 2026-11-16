import type { ChatModels } from "@gates-local/contracts";
import { chatList } from "./chat-list.ts";

export interface CuratedModel {
  readonly name: string;
  readonly label: string;
  readonly purpose: string;
  readonly downloadBytes: number;
  readonly pullable: boolean;
}

const made = new WeakMap<ChatModels, readonly CuratedModel[]>();

export function curatedModels(): readonly CuratedModel[] {
  const list = chatList();
  let models = made.get(list);
  if (models === undefined) {
    models = list.models.map((m) => ({ ...m, pullable: true }));
    made.set(list, models);
  }
  return models;
}

export const OWN_MODEL_PURPOSE = "Installed by you";

// external: Ollama names carry an implicit ":latest".
export const canonicalTag = (name: string) => (name.includes(":") ? name : `${name}:latest`);

export function curated(name: string): CuratedModel | undefined {
  const tag = canonicalTag(name);
  return curatedModels().find((m) => m.name === tag);
}

export function modelLabel(name: string): string {
  const known = curated(name);
  if (known) return known.label;
  const short = name.replace(/:latest$/, "");
  return short.startsWith("hf.co/") ? (short.split("/").pop() ?? short) : short;
}
