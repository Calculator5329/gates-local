// The chat-pick rule, in one place. The catalog runs it on every change to
// the installed list or to the default model or context, and stamps the
// result on that model's ModelInfo.pick, so the first run and the composer
// both read the same answer from models.list.
//
// The rule:
//   1. Only models whose capabilities include "completion" can chat.
//   2. The settings default wins if it can chat and its verdict at the
//      chosen context is not refuse.
//   3. Otherwise rank the chat models: the curated order in recommended.ts
//      first, then the rest by larger parameter count. Every chat model is
//      fitted at once from one GPU reading. The first-ranked that fits
//      on the GPU wins; if none fits, the first that spills to system
//      memory; if every one is refused, the first-ranked one with verdict
//      refuse, so the client can say plainly that nothing fits.
//   4. When a fit could not run, the survey is incomplete: "refuse" is said
//      only when every candidate was refused, otherwise the first-ranked
//      unchecked one comes back with no verdict. An incomplete pick is
//      never cached (models.ts), so the next refresh fits again.
//   A model whose capabilities are unknown (/api/show failed) cannot chat
//   until discovery succeeds, so it is never ranked.
import type { FitReport, FitVerdict } from "../fit/types.ts";
import { canonicalTag, CURATED_MODELS } from "./recommended.ts";
import type { ModelInfo } from "./types.ts";

/**
 * `complete` is false when a fit that could change the answer did not run:
 * the pick is a best guess for now, not a decision to keep. Only `pick`
 * rides on the wire.
 */
export type ChatPick = { name: string; pick: { numCtx: number; verdict?: FitVerdict }; complete: boolean };

export const canChat = (m: { readonly capabilities: readonly string[] }): boolean => m.capabilities.includes("completion");

const curatedIndex = new Map(CURATED_MODELS.map((c, i) => [c.name, i]));

/** "9.7B" → 9.7e9, "137M" → 1.37e8; unknown sizes rank last. */
export function parameterCount(size: string | undefined): number {
  const m = size === undefined ? null : /^([\d.]+)\s*([KMBT])?$/i.exec(size.trim());
  if (!m) return 0;
  const scales: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  const scale = scales[(m[2] ?? "").toUpperCase()] ?? 1;
  return Number(m[1]) * scale;
}

const curatedRank = (m: ModelInfo) => curatedIndex.get(canonicalTag(m.name)) ?? CURATED_MODELS.length;

/** Chat models, best first: curated order, then larger parameter count, then name. */
export function rankChatModels(models: readonly ModelInfo[]): ModelInfo[] {
  return models
    .filter(canChat)
    .toSorted((a, b) => curatedRank(a) - curatedRank(b) || parameterCount(b.parameterSize) - parameterCount(a.parameterSize) || a.name.localeCompare(b.name));
}

export interface PickInput {
  models: readonly ModelInfo[];
  defaultModel?: string;
  numCtx: number;
  /** The fit at numCtx; undefined when the check could not run for this model. */
  fit: (model: string) => Promise<FitReport | undefined>;
}

export async function pickChatModel(input: PickInput): Promise<ChatPick | undefined> {
  const ranked = rankChatModels(input.models);
  const first = ranked[0];
  if (first === undefined) return undefined;
  const at = (name: string, verdict: FitVerdict | undefined, complete: boolean): ChatPick => ({
    name,
    pick: { numCtx: input.numCtx, ...(verdict === undefined ? {} : { verdict }) },
    complete,
  });

  const chosen = input.defaultModel === undefined ? undefined : ranked.find((m) => canonicalTag(m.name) === canonicalTag(input.defaultModel ?? ""));
  // All at once against the one reading: the walk is latency on the first models.list.
  const reports = await Promise.all(ranked.map((m) => input.fit(m.name)));
  const verdictOf = (m: ModelInfo) => reports[ranked.indexOf(m)]?.verdict;
  /** Whether every model ranked above `index` (or all, without one) has a verdict. */
  const checkedBefore = (index = ranked.length) => reports.slice(0, index).every((r) => r !== undefined);
  if (chosen) {
    const v = verdictOf(chosen);
    if (v === undefined) return at(chosen.name, undefined, false);
    if (v !== "refuse") return at(chosen.name, v, true);
  }

  const fits = ranked.findIndex((m) => verdictOf(m) === "fits");
  if (fits !== -1) return at(ranked[fits]?.name ?? first.name, "fits", checkedBefore(fits));
  // A spill is the answer only once nothing unchecked could fit.
  const spills = ranked.find((m) => verdictOf(m) === "spills");
  if (spills) return at(spills.name, "spills", checkedBefore());
  const unchecked = ranked.find((m) => verdictOf(m) === undefined);
  if (unchecked) return at(unchecked.name, undefined, false);
  return at(first.name, "refuse", true);
}
