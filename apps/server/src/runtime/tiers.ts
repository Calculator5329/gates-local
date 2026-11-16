import type { ChatModels } from "@gates-local/contracts";
import { GIB } from "../fit/constants.ts";
import { chatList } from "./chat-list.ts";

export interface Tier {
  readonly by: "gpu" | "system";
  readonly gb: number;
  readonly picks: readonly [string, ...string[]];
}

const tier = (by: Tier["by"]) => (row: { readonly gb: number; readonly picks: readonly string[] }): Tier => {
  const [first, ...rest] = row.picks;
  if (first === undefined) throw new Error(`chat-models.json: the ${by} ${row.gb} GB tier has no pick`);
  return { by, gb: row.gb, picks: [first, ...rest] };
};

const made = new WeakMap<ChatModels, readonly Tier[]>();

export function tiers(): readonly Tier[] {
  const list = chatList();
  let rows = made.get(list);
  if (rows === undefined) {
    rows = [...list.tiers.system.map(tier("system")), ...list.tiers.gpu.map(tier("gpu"))];
    made.set(list, rows);
  }
  return rows;
}

const reaches = (bytes: number, gb: number) => bytes >= gb * GIB * 0.9;

export function tierFor(memory: { gpuCount: number; gpuTotalBytes: number; systemTotalBytes: number }): Tier {
  const by = memory.gpuCount > 0 ? "gpu" : "system";
  const bytes = by === "gpu" ? memory.gpuTotalBytes : memory.systemTotalBytes;
  const rows = tiers().filter((t) => t.by === by).toSorted((a, b) => a.gb - b.gb);
  const smallest = rows[0];
  if (smallest === undefined) throw new Error(`no ${by} tier`);
  return rows.findLast((t) => reaches(bytes, t.gb)) ?? smallest;
}
