import type { CatalogEntry, FitVerdict } from "@gates-local/contracts";
import { friendlyName } from "../lib/words/format.ts";

export const FIT_DOT: Record<FitVerdict, string> = { fits: "ok", spills: "warn", refuse: "off" };

const GB = 1024 ** 3;
export const about = (bytes: number) => {
  const g = bytes / GB;
  return `${g < 9.95 ? g.toFixed(1) : Math.round(g)} GB`;
};

export const sizeText = (bytes: number) => (bytes < GB ? `${Math.round(bytes / 1024 ** 2)} MB` : about(bytes));

export const OWN_MODEL_PURPOSE = "Installed by you";

export interface ModelName {
  readonly text: string;
  readonly purpose: string;
  readonly id?: string;
}

export function nameOf(tag: string, catalog: readonly CatalogEntry[] | undefined): ModelName {
  const c = catalog?.find((e) => e.name === tag);
  if (c !== undefined && c.purpose !== OWN_MODEL_PURPOSE) return { text: c.label, purpose: c.purpose };
  const short = shortTag(tag);
  return { text: friendlyName(short.slice(short.lastIndexOf("/") + 1)), purpose: "", id: tag };
}

export const labelOf = (c: CatalogEntry): string => nameOf(c.name, [c]).text;

export function shortTag(tag: string): string {
  return tag.replace(/:latest$/, "").replace(/^hf\.co\/[^/]+\//, "hf.co/…/");
}

export function splitTail(s: string): readonly [string, string] {
  if (s.length <= 26) return [s, ""];
  for (let i = s.length - 12; i <= s.length - 8; i++) {
    if ("-_.:/".includes(s[i] ?? "")) return [s.slice(0, i + 1), s.slice(i + 1)];
  }
  return [s.slice(0, -10), s.slice(-10)];
}

export interface Row {
  readonly name: string;
  readonly display: string;
  readonly chat: boolean;
  readonly verdict: FitVerdict | undefined;
}

const byDisplay = (a: Row, b: Row) => a.display.localeCompare(b.display, "en", { sensitivity: "base" }) || a.name.localeCompare(b.name);

export function sortRows<T extends Row>(rows: readonly T[], def: string | undefined): T[] {
  const top = rows.find((r) => r.name === def);
  const rest = rows.filter((r) => r !== top).toSorted(byDisplay);
  return top === undefined ? rest : [top, ...rest];
}

const FILTER_FROM = 8;

export const filterShows = (rows: number, typed: string): boolean => rows > FILTER_FROM || typed !== "";

export const noteSettled = (removed: string, saved: string | undefined): boolean => saved !== undefined && saved !== removed;

export function canBeDefault(r: Row, def: string | undefined): boolean {
  return r.name !== def && r.chat && r.verdict !== "refuse";
}

export function nextDefault(sorted: readonly Row[], removed: string, def: string | undefined): string | null | undefined {
  if (removed !== def) return undefined;
  return sorted.find((r) => r.name !== removed && r.chat && r.verdict !== "refuse")?.name ?? null;
}

export const pullName = (typed: string): string => typed.trim().replace(/^ollama\s+(?:run|pull)\s+/i, "").trim();
