// The rules behind Settings › Models, kept pure so tests can pin them: the
// fit words (three label sets, one switch), the installed order, the next
// default after a removal, the Recommended picks with their backfill, the
// download cards, the typed-name library check and the name truncation.
import type { CatalogEntry, FitReport, FitVerdict, PullProgress } from "@gates-local/contracts";
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

/** The word for a verdict in the chosen set. */
export function fitLabel(verdict: FitVerdict, set: FitSet = FIT_SET): string {
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
export function fitReason(r: FitReport): string {
  if (r.verdict === "refuse" && r.contextLimit !== undefined) return `Supports up to ${k(r.contextLimit)} of context; new chats use ${k(r.numCtx)}.`;
  const head = `Needs about ${about(r.needVramBytes)}.`;
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

// ---------------------------------------------------------------- downloads

export const isActive = (p: PullProgress) => p.state === "queued" || p.state === "downloading" || p.state === "verifying";

export interface Cards {
  /** Running or queued, oldest first. */
  readonly running: readonly PullProgress[];
  /** Finished this session: "<Model> is ready" with Start chat. */
  readonly ready: readonly PullProgress[];
  /** Failed, with the server's plain sentence. Not-found names stay with the search field instead. */
  readonly failed: readonly PullProgress[];
}

/** The cards the Download tab pins above the search, from the pull pushes. */
export function downloadCards(pulls: Readonly<Record<string, PullProgress>>, typed = ""): Cards {
  const all = Object.values(pulls);
  return {
    running: all.filter(isActive),
    ready: all.filter((p) => p.state === "done"),
    failed: all.filter((p) => p.state === "error" && !(p.reason === "not-found" && p.name === typed.trim())),
  };
}

// ---------------------------------------------------------------- Recommended

export interface Picks {
  readonly picks: readonly CatalogEntry[];
  /** Every model we'd suggest for this computer is installed. */
  readonly allInstalled: boolean;
  /** Nothing curated runs fully on this computer: the picks run slower, and the heading says so. */
  readonly slower: boolean;
}

/**
 * Recommended: curated models not installed and not downloading that run
 * well here, in the catalog's order, up to `limit`; the next one backfills
 * when one is downloaded. A computer where nothing runs well gets the
 * lightest slower ones, named as such.
 */
export function recommendedPicks(catalog: readonly CatalogEntry[], installed: ReadonlySet<string>, busy: ReadonlySet<string>, limit = 3): Picks {
  const curatedOnly = catalog.filter((c) => c.purpose !== OWN_MODEL_PURPOSE);
  const have = (c: CatalogEntry) => c.installed || installed.has(c.name);
  const runsWell = curatedOnly.filter((c) => c.fit?.verdict === "fits");
  if (runsWell.length > 0) {
    const picks = runsWell.filter((c) => !have(c) && !busy.has(c.name)).slice(0, limit);
    return { picks, allInstalled: picks.length === 0 && runsWell.every(have), slower: false };
  }
  const slower = curatedOnly
    .filter((c) => c.fit?.verdict === "spills" && !have(c) && !busy.has(c.name))
    .toSorted((a, b) => a.downloadBytes - b.downloadBytes)
    .slice(0, limit);
  return { picks: slower, allInstalled: false, slower: slower.length > 0 };
}

// ---------------------------------------------------------------- typed names

/** The search box, matched against the catalog: label or tag, case ignored. */
export function matchCatalog(catalog: readonly CatalogEntry[], q: string): CatalogEntry[] {
  const t = q.trim().toLowerCase();
  if (t === "") return [];
  return catalog.filter((c) => c.name.toLowerCase().includes(t) || c.label.toLowerCase().includes(t));
}

/** Ollama names carry an implicit ":latest". */
const canonical = (name: string) => (name.includes(":") ? name : `${name}:latest`);

/** Text that could be an Ollama model name: no spaces, the characters Ollama allows. */
export const looksLikeTag = (q: string) => /^[a-z0-9][a-z0-9._\-/:]*$/i.test(q.trim());

export type Lookup =
  | { readonly k: "none" }
  /** In the catalog: size and fit known before downloading. */
  | { readonly k: "catalog"; readonly entry: CatalogEntry }
  /** Already installed. */
  | { readonly k: "installed" }
  /** Not checked yet: Download asks the library. */
  | { readonly k: "unchecked" }
  /** The download started and Ollama has not answered with a size yet. */
  | { readonly k: "checking" }
  /** Ollama found it: the download runs, its card is above. */
  | { readonly k: "found"; readonly totalBytes: number }
  /** Ollama has no such model. */
  | { readonly k: "not-found" };

/**
 * The library row for a typed name. Gates Local asks no registry of its own:
 * a name in the catalog answers at once, any other name is checked by
 * starting its download, so "checking" lasts until Ollama sends a size or
 * says there is no such model.
 */
export function lookup(q: string, catalog: readonly CatalogEntry[], installed: ReadonlySet<string>, pulls: Readonly<Record<string, PullProgress>>): Lookup {
  const name = q.trim();
  if (name === "" || !looksLikeTag(name)) return { k: "none" };
  const tag = canonical(name);
  if (installed.has(name) || installed.has(tag)) return { k: "installed" };
  const p = pulls[name] ?? pulls[tag];
  if (p !== undefined && p.state === "error" && p.reason === "not-found") return { k: "not-found" };
  if (p !== undefined && isActive(p)) return p.totalBytes ? { k: "found", totalBytes: p.totalBytes } : { k: "checking" };
  const entry = catalog.find((c) => c.name === name || c.name === tag);
  if (entry !== undefined) return entry.installed ? { k: "installed" } : { k: "catalog", entry };
  return { k: "unchecked" };
}

// ---------------------------------------------------------------- download progress

/** "42%", "about 2 min left", "3.9 of 9.3 GB", "41 MB/s": the pieces of a progress line. */
export function progressParts(p: PullProgress): { pct: number | null; left: string | null; got: string | null; rate: string | null } {
  const total = p.totalBytes;
  if (p.state === "verifying") return { pct: 100, left: "Verifying", got: null, rate: null };
  if (!total) return { pct: null, left: null, got: null, rate: null };
  const pct = Math.min(100, Math.floor((p.completedBytes / total) * 100));
  const rate = p.bytesPerSecond ? `${Math.round(p.bytesPerSecond / 1e6)} MB/s` : null;
  const secs = p.bytesPerSecond ? (total - p.completedBytes) / p.bytesPerSecond : null;
  const left = secs === null ? null : secs < 60 ? "under a minute left" : `about ${Math.ceil(secs / 60)} min left`;
  return { pct, left, got: `${(p.completedBytes / GB).toFixed(1)} of ${about(total)}`, rate };
}
