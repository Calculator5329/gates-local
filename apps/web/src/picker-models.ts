import type { CatalogEntry, ModelInfo, PullProgress } from "@gates-local/contracts";
import { friendlyName, type Verdict } from "./format.ts";
import { chatModels, pendingDownload } from "./pick.ts";

export type Maker = "Gemma" | "Qwen" | "Milo" | "gpt-oss" | "Phi" | "Mistral" | "Other";

/** Display brands stay stable across local aliases, quantizations and hosted variants. */
export function makerOf(tag: string): Maker {
  const lower = tag.toLowerCase();
  if (lower.includes("gemma")) return "Gemma";
  if (lower.includes("qwen")) return "Qwen";
  if (lower.includes("milo")) return "Milo";
  if (lower.includes("gpt-oss")) return "gpt-oss";
  if (/(?:^|\/)phi\d/.test(lower)) return "Phi";
  if (lower.includes("mistral")) return "Mistral";
  return "Other";
}

/** Tags remain the identity and tooltip; packaging words do not become the visible name. */
export function pickerLabel(tag: string, catalogLabel?: string): string {
  if (tag.startsWith("hf.co/llmfan46/gemma-4-26B-")) return "Gemma 4 26B ultra-uncensored (llmfan46)";
  if (tag.startsWith("hf.co/0bserverx/Qwen3.8-27B-")) return "Qwen 3.8 27B Heretic (0bserverx)";
  const milo = /^milo-(e\d+b)-(v\d+)(?::latest)?$/i.exec(tag);
  if (milo) return `Milo ${milo[1]?.toUpperCase()} ${milo[2]?.toLowerCase()}`;
  const oss = /^gpt-oss:(\d+)b/i.exec(tag);
  if (oss) return `gpt-oss ${oss[1]}B`;
  const raw = tag.replace(/:latest$/, "");
  if (catalogLabel && catalogLabel !== tag && catalogLabel !== raw && /\s/.test(catalogLabel)) return catalogLabel;
  return friendlyName(tag);
}

/** Only colliding display names gain a suffix; identical quantization suffixes use the full tag. */
export function pickerLabels(tags: readonly string[], catalog: readonly { name: string; label: string }[] = []): ReadonlyMap<string, string> {
  const labels = new Map([...new Set(tags)].map(tag => [tag, pickerLabel(tag, catalog.find(c => c.name === tag)?.label)]));
  const groups = new Map<string, string[]>();
  for (const [tag, label] of labels) groups.set(label, [...(groups.get(label) ?? []), tag]);
  for (const [label, peers] of groups) {
    if (peers.length < 2) continue;
    const suffixes = peers.map(tag => tag.includes(":") ? tag.slice(tag.lastIndexOf(":") + 1) : tag);
    for (const [i, tag] of peers.entries()) {
      const suffix = suffixes[i];
      labels.set(tag, `${label} · ${suffix && suffixes.filter(s => s === suffix).length === 1 ? suffix : tag}`);
    }
  }
  return labels;
}

/** One picker row before its fit report: an installed chat model (`info`) or a pending download (`pull`). */
export interface PickerEntry { readonly tag: string; readonly label: string; readonly name: string; readonly variant: string; readonly info?: ModelInfo; readonly pull?: PullProgress }

/**
 * Every row the picker lists, in its order: the selected model first, then by
 * visible label. The picker and its intent warm-up both read this, so the row
 * one prepares is the row the other shows.
 */
export function pickerEntries(models: readonly ModelInfo[] | undefined, pulls: Readonly<Record<string, PullProgress>>, catalog: readonly CatalogEntry[] | undefined, selected: string | undefined): PickerEntry[] {
  const installed = chatModels(models ?? []);
  const downloading = Object.values(pulls).filter(p => pendingDownload(p, models));
  const labels = pickerLabels([...installed.map(m => m.name), ...downloading.map(p => p.name)], catalog);
  const entry = (tag: string) => {
    const name = pickerLabel(tag, catalog?.find(c => c.name === tag)?.label), label = labels.get(tag) ?? name;
    return { tag, name, label, variant: label === name ? "" : label.slice(name.length + 3) };
  };
  return [...installed.map(info => ({ ...entry(info.name), info })), ...downloading.map(pull => ({ ...entry(pull.name), pull }))]
    .toSorted((a, b) => Number(b.tag === selected) - Number(a.tag === selected) || a.label.localeCompare(b.label, undefined, { numeric: true }));
}

/** The row the context column describes: a pending choice, else the highlighted row, else the selected one, else the first listed. */
export function activeEntry<R extends { readonly tag: string }>(visible: readonly R[], selected: string | undefined, highlight: string | null = null, choice?: R): R | undefined {
  return choice ?? visible.find(r => r.tag === highlight) ?? visible.find(r => r.tag === selected) ?? visible[0];
}

/** Presentation only: the track ends at usable memory; a dashed extension shows overflow. */
export function memoryRuler(need: number, usable: number): { fill: number; overflow: number; continues: boolean } {
  if (usable <= 0) return { fill: 0, overflow: 36, continues: true };
  const cost = Math.max(0, need / usable * 100);
  return { fill: Math.min(100, cost), overflow: Math.min(36, Math.max(0, cost - 100)), continues: cost > 136 };
}

/** A measured report's free memory is after allocation; its existing spill is authoritative. */
export function contextRuler(v: Verdict) {
  if (!v.measured) {
    const room = Math.max(0, v.avail - 512 * 1024 ** 2);
    return { ...memoryRuler(v.need, room), room };
  }
  const spill = v.k === "spill" ? v.amt : 0;
  const held = Math.max(0, v.need - spill), room = held + v.avail;
  const allocated = memoryRuler(held, room);
  const extension = spill > 0 ? memoryRuler(room + spill, room) : { overflow: 0, continues: false };
  return { ...allocated, overflow: extension.overflow, continues: extension.continues, room };
}
