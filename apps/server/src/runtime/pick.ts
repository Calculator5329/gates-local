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
//   4. When the fit check cannot run (no GPU reading), the first-ranked one,
//      with no verdict.
import type { FitReport, FitVerdict } from "../fit/types.ts";
import { canonicalTag, CURATED_MODELS } from "./recommended.ts";
import type { ModelInfo } from "./types.ts";

export type ChatPick = { name: string; pick: { numCtx: number; verdict?: FitVerdict } };

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
  const at = (name: string, verdict: FitVerdict | undefined): ChatPick => ({
    name,
    pick: { numCtx: input.numCtx, ...(verdict === undefined ? {} : { verdict }) },
  });

  const chosen = input.defaultModel === undefined ? undefined : ranked.find((m) => canonicalTag(m.name) === canonicalTag(input.defaultModel ?? ""));
  // All at once against the one reading: the walk is latency on the first models.list.
  const reports = await Promise.all(ranked.map((m) => input.fit(m.name)));
  const verdictOf = (m: ModelInfo) => reports[ranked.indexOf(m)]?.verdict;
  if (chosen && verdictOf(chosen) !== "refuse") return at(chosen.name, verdictOf(chosen));

  const fits = ranked.find((m) => verdictOf(m) === "fits");
  if (fits) return at(fits.name, "fits");
  const spills = ranked.find((m) => verdictOf(m) === "spills");
  if (spills) return at(spills.name, "spills");
  return at(first.name, reports.some((r) => r !== undefined) ? "refuse" : undefined);
}
