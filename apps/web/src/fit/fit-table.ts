import type { FitMemory, FitReport, FitRow, FitTable, GpuOccupant } from "@gates-local/contracts";
import { cardGb, ctxFor } from "../lib/words/format.ts";

export interface SlowNow {
  readonly inTheWay: readonly GpuOccupant[];
  readonly spillRamBytes: number;
}

export type TableFit = FitReport & Pick<FitRow, "stops" | "card"> & { readonly slowNow?: SlowNow };

export function cardFit(fit: TableFit | undefined): TableFit | undefined {
  if (fit?.card === undefined) return fit;
  let report = cards.get(fit);
  if (report === undefined) {
    const { shortfallBytes: _rightNow, card, ...rest } = fit;
    const { inTheWay, ...verdict } = card;
    report = { ...rest, ...verdict, ...(inTheWay === undefined ? {} : { slowNow: { inTheWay, spillRamBytes: fit.spillRamBytes } }) };
    cards.set(fit, report);
  }
  return report;
}

// why: a selector that returns a report keeps its identity until the next table
const cards = new WeakMap<TableFit, TableFit>();
const reports = new WeakMap<FitRow, TableFit>();

export function fitFor(table: FitTable | undefined, model: string | undefined, numCtx: number): TableFit | undefined {
  if (table === undefined || model === undefined) return undefined;
  const row = table.rows.find((r) => r.model === model && r.numCtx === numCtx);
  if (row === undefined) return undefined;
  let report = reports.get(row);
  if (report === undefined) {
    report = { ...row, measuredAt: table.reading.measuredAt };
    reports.set(row, report);
  }
  return report;
}

export function rowOf(s: { readonly fitTable: FitTable | undefined; readonly models: readonly { readonly name: string; readonly maxContext?: number }[] | undefined; readonly numCtx: number }, model: string | undefined, numCtx = s.numCtx): TableFit | undefined {
  return cardFit(fitFor(s.fitTable, model, ctxFor(numCtx, s.models, model)));
}

export const answers = (table: FitTable | undefined): table is FitTable => table !== undefined && table.memory.kind !== "unreadable" && table.rows.length > 0;

export type RowPhase = "fresh" | "checking" | "none";
export const phaseOf = (table: FitTable | undefined, fit: TableFit | undefined): RowPhase => fit !== undefined ? "fresh" : answers(table) ? "none" : "checking";

export const stopsChat = (fit: TableFit | undefined): boolean => (fit?.stops.length ?? 0) > 0;

export const refusedNow = (fit: TableFit | undefined): boolean => fit !== undefined && fit.verdict === "refuse" && !stopsChat(fit);

export const canPick = (fit: TableFit | undefined): boolean => fit !== undefined && (fit.verdict !== "refuse" || stopsChat(fit));

export function cardLine(m: FitMemory, whole: number | undefined): string {
  if (m.kind === "cpu") return "Runs in system memory";
  if (m.kind === "unreadable") return "GPU reading unavailable";
  if (whole === undefined) return "";
  return m.gpuCount !== undefined && m.gpuCount > 1 ? `${m.gpuCount} GPUs, ${cardGb(whole)}` : `${cardGb(whole)} GPU`;
}
