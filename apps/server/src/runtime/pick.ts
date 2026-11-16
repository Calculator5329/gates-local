import type { FitReport, FitVerdict } from "../fit/types.ts";
import { canonicalTag, curatedModels } from "./recommended.ts";
import type { ModelInfo } from "./types.ts";

export type ChatPick = { name: string; pick: { numCtx: number; verdict?: FitVerdict }; complete: boolean };

export const canChat = (m: { readonly capabilities: readonly string[] }): boolean => m.capabilities.includes("completion");

export function parameterCount(size: string | undefined): number {
  const m = size === undefined ? null : /^([\d.]+)\s*([KMBT])?$/i.exec(size.trim());
  if (!m) return 0;
  const scales: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  const scale = scales[(m[2] ?? "").toUpperCase()] ?? 1;
  return Number(m[1]) * scale;
}

export function rankChatModels(models: readonly ModelInfo[]): ModelInfo[] {
  const curated = curatedModels();
  const curatedIndex = new Map(curated.map((c, i) => [c.name, i]));
  const curatedRank = (m: ModelInfo) => curatedIndex.get(canonicalTag(m.name)) ?? curated.length;
  return models
    .filter(canChat)
    .toSorted((a, b) => curatedRank(a) - curatedRank(b) || parameterCount(b.parameterSize) - parameterCount(a.parameterSize) || a.name.localeCompare(b.name));
}

export interface PickInput {
  models: readonly ModelInfo[];
  defaultModel?: string;
  numCtx: number;
  fit: (model: string) => Promise<FitReport | undefined>;
}

export async function pickChatModel(input: PickInput): Promise<ChatPick | undefined> {
  const ranked = rankChatModels(input.models);
  const first = ranked[0];
  if (first === undefined) return undefined;
  const chosen = input.defaultModel === undefined ? undefined : ranked.find((m) => canonicalTag(m.name) === canonicalTag(input.defaultModel ?? ""));
  // why: fitted one at a time, the fits would add up as latency on the first models.list
  const reports = await Promise.all(ranked.map((m) => input.fit(m.name)));
  const at = (name: string, verdict: FitVerdict | undefined, complete: boolean): ChatPick => ({
    name,
    pick: { numCtx: reports[ranked.findIndex((m) => m.name === name)]?.numCtx ?? input.numCtx, ...(verdict === undefined ? {} : { verdict }) },
    complete,
  });
  const verdictOf = (m: ModelInfo) => reports[ranked.indexOf(m)]?.verdict;
  const checkedBefore = (index = ranked.length) => reports.slice(0, index).every((r) => r !== undefined);
  if (chosen) {
    const v = verdictOf(chosen);
    if (v === undefined) return at(chosen.name, undefined, false);
    if (v !== "refuse") return at(chosen.name, v, true);
  }

  const fits = ranked.findIndex((m) => verdictOf(m) === "fits");
  if (fits !== -1) return at(ranked[fits]?.name ?? first.name, "fits", checkedBefore(fits));
  const spills = ranked.find((m) => verdictOf(m) === "spills");
  if (spills) return at(spills.name, "spills", checkedBefore());
  const unchecked = ranked.find((m) => verdictOf(m) === undefined);
  if (unchecked) return at(unchecked.name, undefined, false);
  return at(first.name, "refuse", true);
}
