import type { FitReport, FitVerdict, FitWords } from "./shapes.ts";

const GIB = 1024 ** 3;

/** The no-break space between a number and its unit. */
export const NBSP = String.fromCharCode(160);

/** "6.6 GB": one decimal everywhere, and a no-break space so the unit never wraps away. Sizes are GiB (16303 MiB reads 15.9 GB). */
export function gb(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)}${NBSP}GB`;
}

/** "16k": a context size as the app names it. */
export function k(numCtx: number): string {
  return numCtx < 1024 ? String(numCtx) : `${Math.round(numCtx / 1024)}k`;
}

/**
 * The words for one report on one basis ("card": against the card's own memory, as every list shows
 * it; "now": against what is free right now, as a send loads it). `cpu`: no supported GPU, so
 * whatever loads runs in system memory.
 */
export function fitWords(r: Pick<FitReport, "verdict" | "numCtx" | "needVramBytes" | "freeVramBytes" | "spillRamBytes" | "shortfallBytes" | "source">, basis: FitWords["basis"], cpu: boolean): FitWords {
  const measured = r.source === "measured";
  const label = labelOf(r.verdict, measured, cpu);
  if (r.verdict === "fits") {
    // external: Ollama may report VRAM on a card nvidia-smi does not list
    if (cpu) return { basis, k: "gpu", label, word: "Runs in system memory", chip: "system memory", detail: "", mark: "Runs in system memory", short: "System memory", amt: 0 };
    return { basis, k: "gpu", label, word: "Runs on GPU", chip: "on GPU", detail: "", mark: "Runs on the GPU", short: "Fits", amt: 0 };
  }
  if (r.verdict === "spills") {
    return {
      basis,
      k: "spill",
      label,
      word: "Uses system memory · slower",
      chip: "system memory",
      detail: `${gb(r.spillRamBytes)} in system memory`,
      mark: cpu ? "Runs in system memory, slower" : "Partly in system memory, slower",
      short: cpu ? "System memory" : "Slower",
      amt: r.spillRamBytes,
    };
  }
  const short = r.shortfallBytes ?? Math.max(0, r.needVramBytes - r.freeVramBytes);
  return { basis, k: "no", label, word: `Not enough memory at ${k(r.numCtx)}`, chip: "not enough memory", detail: `needs ${gb(short)} more`, mark: "Too big for this computer", short: "Too big", amt: short };
}

function labelOf(verdict: FitVerdict, measured: boolean, cpu: boolean): string {
  if (verdict === "refuse") return "Won't run here";
  return `${measured ? "Runs" : "Should run"} ${cpu ? "in system memory" : verdict === "fits" ? "well" : "slower"}`;
}

/**
 * The picker's word for a card verdict once the row's right-now facts are in: a send stops another
 * chat first ("Stops chat"), or the card holds it and a send now is refused ("Not now").
 */
export function withNow(card: FitWords, now: { readonly verdict: FitVerdict; readonly stops: readonly string[] }): FitWords {
  if (now.stops.length > 0) return { ...card, short: "Stops chat" };
  if (card.k !== "no" && now.verdict === "refuse") return { ...card, short: "Not now" };
  return card;
}
