import type { FitReport } from "@gates-local/contracts";
import { composerFit } from "./composer-fit.ts";
import { verdictOf } from "./format.ts";

/** Presentation history only. Selection and sending still check the raw report. */
export function createFitDisplay() {
  const entries = new Map<string, { held?: FitReport; duringLoad?: FitReport | "error" }>();
  return (key: string, raw: FitReport | "error" | undefined, loading: boolean, previous?: FitReport): FitReport | undefined => {
    if (raw === undefined && !loading) { entries.delete(key); return undefined; }
    const entry = entries.get(key) ?? { held: loading ? previous : undefined };
    if (loading) entry.duringLoad = raw;
    const held = entry.held === undefined ? undefined : verdictOf(entry.held);
    const cached = raw === undefined || raw === "error" ? raw : verdictOf(raw);
    const next = composerFit(held, cached, loading, raw === entry.duringLoad);
    const shown = next.shown === held ? entry.held : raw === "error" ? undefined : raw;
    entry.held = next.held === held ? entry.held : raw === "error" ? undefined : raw;
    entries.set(key, entry);
    return shown;
  };
}

// Picker and Settings unmount when closed. Share their last reading so opening
// either midway through the same load does not forget the pre-load advice.
export const displayFit = createFitDisplay();
