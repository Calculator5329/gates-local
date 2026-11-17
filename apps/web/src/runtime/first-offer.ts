import type { CatalogEntry } from "@gates-local/contracts";
import { rowOf } from "../fit/fit-table.ts";
import { canChat, chatBlockedReason } from "../models/pick.ts";
import { NA, type State } from "../lib/store/store.ts";

export function recommendedEntry(s: State): CatalogEntry | undefined {
  if (s.catalog === NA || s.catalog === undefined) return undefined;
  const picks = s.catalog.filter((c) => c.recommended).toSorted((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  return picks.find((c) => rowOf(s, c.name)?.verdict !== "refuse") ?? picks[0];
}

export function firstModelOffer(s: State): CatalogEntry | undefined {
  if (s.runtime?.state !== "ready" || s.models === undefined || s.models.some(canChat)) return undefined;
  if (chatBlockedReason(s.models, undefined) !== undefined || s.unavailable["models.pull"] === true) return undefined;
  return recommendedEntry(s);
}
