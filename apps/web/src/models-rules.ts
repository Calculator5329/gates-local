// The rules behind Settings › Models, kept pure so tests can pin them: the
// fit words, the installed order, the next default after a removal and the
// name truncation.
import type { CatalogEntry, FitReport, FitVerdict } from "@gates-local/contracts";
import { friendlyName } from "./format.ts";

// ---------------------------------------------------------------- fit words

/**
 * The one sentence for a fit, on Models and on GPU memory. "Should" until the
 * model has really run at that size (`measured`). With no supported GPU,
 * whatever loads runs in system memory.
 */
export function fitLabel(verdict: FitVerdict, measured = false, cpu = false): string {
  if (verdict === "refuse") return "Won't run here";
  return `${measured ? "Runs" : "Should run"} ${cpu ? "in system memory" : verdict === "fits" ? "well" : "slower"}`;
}

/** The dot beside that sentence. A model too big for this machine is a limit, not a failure, so it is gray. */
export const FIT_DOT: Record<FitVerdict, string> = { fits: "ok", spills: "warn", refuse: "off" };

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

/** A model's name on the page: curated models by label and purpose; any other by a cleaned name, with its Ollama id and no tagline. */
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

/**
 * What tells apart options that would otherwise read alike, by model name:
 * each id less the parts all of them share, so "local/model:9b-q4_K_M" and
 * "local/model:9b-q8_0" come back as "q4_K_M" and "q8_0". Names already
 * unique on the page get no entry.
 */
export function optionVariants(options: readonly { readonly name: string; readonly label: { readonly text: string } }[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const text of new Set(options.map((o) => o.label.text))) {
    const names = options.filter((o) => o.label.text === text).map((o) => o.name);
    if (names.length < 2) continue;
    const shown = withoutSharedParts(names);
    names.forEach((n, i) => out.set(n, new Set(shown).size === names.length ? (shown[i] ?? n) : n));
  }
  return out;
}

function withoutSharedParts(names: readonly string[]): string[] {
  const parts = names.map((n) => n.split(/(?<=[/:-])/));
  const room = Math.min(...parts.map((p) => p.length)) - 1;
  const shared = (at: (p: readonly string[]) => string | undefined) => new Set(parts.map(at)).size === 1;
  let head = 0;
  while (head < room && shared((p) => p[head])) head++;
  let tail = 0;
  while (head + tail < room && shared((p) => p[p.length - 1 - tail])) tail++;
  return parts.map((p) => p.slice(head, p.length - tail).join("").replace(/[/:-]$/, ""));
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

/** The filter field shows once the list is longer than this. */
const FILTER_FROM = 8;

/** A long list gets the filter, and it stays while it holds text: hiding it would leave a filter nobody can clear. */
export const filterShows = (rows: number, typed: string): boolean => rows > FILTER_FROM || typed !== "";

/** A note that the next default could not be saved is settled once any default other than the removed model is saved. */
export const noteSettled = (removed: string, saved: string | undefined): boolean => saved !== undefined && saved !== removed;

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
