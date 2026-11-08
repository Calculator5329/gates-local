// The rules behind Settings › Models, kept pure so tests can pin them: the
// fit words (three label sets, one switch), the installed order, the next
// default after a removal and the name truncation.
import type { CatalogEntry, FitReport, FitVerdict } from "@gates-local/contracts";
import { k } from "./format.ts";

// ---------------------------------------------------------------- fit words

/**
 * The three label sets the design council weighed (models-a4 fit variants).
 * (b) is built: "Runs well" stays quiet, the two exceptions carry colour and
 * a symbol. (a) and (c) are one change of FIT_SET away.
 */
export const FIT_LABELS = {
  a: { fits: "Runs on your GPU", spills: "Slower, uses system memory", refuse: "Too big for this computer" },
  b: { fits: "Runs well", spills: "Runs slower", refuse: "Won't run here" },
  c: { fits: "Runs on your GPU", spills: "Slower, uses system memory", refuse: "Too big for this computer" },
} as const satisfies Record<string, Record<FitVerdict, string>>;

export type FitSet = keyof typeof FIT_LABELS;
export const FIT_SET: FitSet = "b";

/** The word for a verdict in the chosen set. With no supported GPU, whatever loads runs in system memory. */
export function fitLabel(verdict: FitVerdict, set: FitSet = FIT_SET, cpu = false): string {
  if (cpu && verdict !== "refuse") return "Runs in system memory";
  return FIT_LABELS[set][verdict];
}

export type FitSymbol = "slow" | "big" | "ok";

/** The glyph before the word: only the exceptions carry one, except in (c), where the normal case gets a muted dot. */
export function fitSymbol(verdict: FitVerdict, set: FitSet = FIT_SET): FitSymbol | null {
  if (verdict === "spills") return "slow";
  if (verdict === "refuse") return "big";
  return set === "c" ? "ok" : null;
}

/** The app's GB is GiB (format.ts gb), so these numbers match every other surface. */
const GB = 1024 ** 3;
/** Whole GB from 10 up, one decimal below, as the A4 tooltips read ("Needs about 15 GB", "about 7.5 GB"). */
export const about = (bytes: number) => {
  const g = bytes / GB;
  return `${g < 9.95 ? g.toFixed(1) : Math.round(g)} GB`;
};

/** A model's size in the Size column: MB under 1 GB, else as `about`. */
export const sizeText = (bytes: number) => (bytes < GB ? `${Math.round(bytes / 1024 ** 2)} MB` : about(bytes));

/** The reason behind a verdict, outcome first, one number per resource. */
export function fitReason(r: FitReport, cpu = false): string {
  if (r.verdict === "refuse" && r.contextLimit !== undefined) return `Supports up to ${k(r.contextLimit)} of context; new chats use ${k(r.numCtx)}.`;
  const head = `Needs about ${about(r.needVramBytes)}.`;
  if (cpu) return `${head} This computer has no supported GPU, ${r.verdict === "refuse" ? "and system memory can't hold it, so it can't load." : "so it runs in slower system memory."}`;
  const gpu = `Your GPU has ${about(r.freeVramBytes)} free`;
  if (r.verdict === "fits") return `${head} ${gpu}, so it runs entirely on the GPU.`;
  if (r.verdict === "spills") return `${head} ${gpu}, so the rest runs in slower system memory.`;
  return `${head} ${gpu}, and system memory can't hold the rest, so it can't load.`;
}

// ---------------------------------------------------------------- what a model is

/** The purpose the server gives an installed model it does not curate (recommended.ts OWN_MODEL_PURPOSE). */
export const OWN_MODEL_PURPOSE = "Installed by you";

/** A model's name on the page: curated models by label and purpose; any other by its tag, in mono. */
export interface ModelName {
  readonly text: string;
  readonly purpose: string;
  readonly mono: boolean;
}

export function nameOf(tag: string, catalog: readonly CatalogEntry[] | undefined): ModelName {
  const c = catalog?.find((e) => e.name === tag);
  if (c !== undefined && c.purpose !== OWN_MODEL_PURPOSE) return { text: c.label, purpose: c.purpose, mono: false };
  return { text: shortTag(tag), purpose: "", mono: true };
}

// ---------------------------------------------------------------- names that do not fit

/** "hf.co/user/repo-GGUF:Q4_K_M" → "hf.co/…/repo-GGUF:Q4_K_M"; ":latest" dropped. */
export function shortTag(tag: string): string {
  return tag.replace(/:latest$/, "").replace(/^hf\.co\/[^/]+\//, "hf.co/…/");
}

/**
 * Split a long name so CSS can cut its middle: the head ellipsizes and the
 * tail (the quant or size, 8 to 12 characters) always shows. One ellipsis,
 * the same join at every width. Short names come back whole.
 */
export function splitTail(s: string): readonly [string, string] {
  if (s.length <= 26) return [s, ""];
  for (let i = s.length - 12; i <= s.length - 8; i++) {
    if ("-_.:/".includes(s[i] ?? "")) return [s.slice(0, i + 1), s.slice(i + 1)];
  }
  return [s.slice(0, -10), s.slice(-10)];
}

// ---------------------------------------------------------------- installed list

export interface Row {
  readonly name: string;
  readonly display: string;
  readonly chat: boolean;
  /** undefined while the fit check runs, or for a model that never chats. */
  readonly verdict: FitVerdict | undefined;
}

const byDisplay = (a: Row, b: Row) => a.display.localeCompare(b.display, "en", { sensitivity: "base" }) || a.name.localeCompare(b.name);

/** The default first, then every other model A to Z by the name shown, case ignored. */
export function sortRows<T extends Row>(rows: readonly T[], def: string | undefined): T[] {
  const top = rows.find((r) => r.name === def);
  const rest = rows.filter((r) => r !== top).toSorted(byDisplay);
  return top === undefined ? rest : [top, ...rest];
}

/** The row menu offers "Use as default" on any chat model that can load, except the current default. */
export function canBeDefault(r: Row, def: string | undefined): boolean {
  return r.name !== def && r.chat && r.verdict !== "refuse";
}

/**
 * The default after removing `removed`: unchanged unless it was the default;
 * then the next chat model in list order that can load, or null when none is
 * left. The remove dialog names this model, and the remove applies it.
 */
export function nextDefault(sorted: readonly Row[], removed: string, def: string | undefined): string | null | undefined {
  if (removed !== def) return undefined;
  return sorted.find((r) => r.name !== removed && r.chat && r.verdict !== "refuse")?.name ?? null;
}
