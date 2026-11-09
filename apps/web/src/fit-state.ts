import type { FitReport } from "@gates-local/contracts";
import { NA, type State, fitKey } from "./store.ts";

export type FitPhase = State["fitStatus"][string];
type FitState = Pick<State, "fits" | "catalog"> & Partial<Pick<State, "fitStatus" | "fitHistory">>;

/** A cached report is history until its check for the latest memory reading succeeds. */
export function fitReading(s: FitState, model: string, numCtx: number): { report: FitReport | undefined; phase: FitPhase } {
  const key = fitKey(model, numCtx);
  const entry = s.catalog === NA ? undefined : s.catalog?.find(c => c.name === model)?.fit;
  const raw = s.fits[key] ?? (entry?.numCtx === numCtx ? entry : undefined);
  const report = raw === "error" ? s.fitHistory?.[key] : raw;
  return { report, phase: s.fitStatus?.[key] ?? (raw === "error" ? "error" : report === undefined ? "checking" : "fresh") };
}

export function currentFit(s: FitState, model: string, numCtx: number): FitReport | undefined {
  const reading = fitReading(s, model, numCtx);
  return reading.phase === "fresh" ? reading.report : undefined;
}

export const fitPendingWord = (phase: FitPhase, history: boolean) => phase === "error" ? "Couldn't check" : history ? "Rechecking…" : "Checking…";
