// Which curated models the app recommends on a computer: one tier per amount of memory, each
// naming a first pick and up to two alternates, the way image defaults name one per card size.
// A computer with a supported GPU is placed by the GPU's memory; one without, by its system
// memory. Both are the memory the computer has, never what is free right now (the owner's ruling,
// 2026-11-13).
//
// PROVISIONAL: the picks start from the pre-download fit estimate at the default 16k context
// (weights from the download, a KV cache of a tenth of it, 1 GiB overhead; fit/fit.ts
// preDownloadNeed), not from measurements. They are to be measured on the test machines and
// adjusted here. The screen never says so: it shows the picks as the recommendation.
//
// Estimated need at 16k, in GiB: qwen3.5:4b 4.4, qwen3.5:9b 7.7, gemma4:12b 9.2,
// gpt-oss:20b 15.1, qwen3.8:27b 19.2.
//
// Without a GPU every model runs in system memory and speed falls with size, so the picks there
// favour small models; gpt-oss 20B activates about 3.6B of its weights per token, so it is the
// quick large pick once there is room for it. On 12 and 16 GB cards the 9B stays first: a quick
// download that leaves the card room for a longer context and for the GPU's other apps (speech,
// images); the larger models follow it as alternates. The picks themselves are data, in
// packages/contracts/src/chat-models.json or the newer signed list in use (chat-list.ts).
import type { ChatModels } from "@gates-local/contracts";
import { GIB } from "../fit/constants.ts";
import { chatList } from "./chat-list.ts";

export interface Tier {
  /** "gpu" places by the GPU's memory; "system" by system memory on a computer with no supported GPU. */
  readonly by: "gpu" | "system";
  /** The memory the tier starts at, as its label says it ("8 GB"). */
  readonly gb: number;
  /** Ollama tags from curatedModels(): the first pick, then up to two alternates. */
  readonly picks: readonly [string, ...string[]];
}

const tier = (by: Tier["by"]) => (row: { readonly gb: number; readonly picks: readonly string[] }): Tier => {
  const [first, ...rest] = row.picks;
  if (first === undefined) throw new Error(`chat-models.json: the ${by} ${row.gb} GB tier has no pick`);
  return { by, gb: row.gb, picks: [first, ...rest] };
};

const made = new WeakMap<ChatModels, readonly Tier[]>();

/** Every tier of the list in use, system ones first. */
export function tiers(): readonly Tier[] {
  const list = chatList();
  let rows = made.get(list);
  if (rows === undefined) {
    rows = [...list.tiers.system.map(tier("system")), ...list.tiers.gpu.map(tier("gpu"))];
    made.set(list, rows);
  }
  return rows;
}

/**
 * A memory reading is a little under its label: a "16 GB" card reads 15.9 GiB and an "8 GB"
 * laptop 7.6 GiB, with part held by firmware. A tier takes anything within 10% under its label.
 */
const reaches = (bytes: number, gb: number) => bytes >= gb * GIB * 0.9;

/**
 * The tier for a computer: the largest one its memory reaches, by the GPU's memory when it has a
 * supported GPU and by system memory when not. Below the smallest tier, the smallest one.
 */
export function tierFor(memory: { gpuCount: number; gpuTotalBytes: number; systemTotalBytes: number }): Tier {
  const by = memory.gpuCount > 0 ? "gpu" : "system";
  const bytes = by === "gpu" ? memory.gpuTotalBytes : memory.systemTotalBytes;
  const rows = tiers().filter((t) => t.by === by).toSorted((a, b) => a.gb - b.gb);
  const smallest = rows[0];
  if (smallest === undefined) throw new Error(`no ${by} tier`);
  return rows.findLast((t) => reaches(bytes, t.gb)) ?? smallest;
}
