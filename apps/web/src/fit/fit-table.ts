// The server's fit table: every model at every offered context from one GPU reading, pushed as
// fit.changed. The client keeps the last one and reads every fit value on screen from it; it asks
// for no single fit and holds no verdict of its own.
import type { FitMemory, FitReport, FitRow, FitTable, GpuOccupant } from "@gates-local/contracts";
import { cardGb, ctxFor } from "../lib/words/format.ts";

/** Right now the model spills though the card holds it: who holds the card (the server's card.inTheWay) and what spills. */
export interface SlowNow {
  readonly inTheWay: readonly GpuOccupant[];
  readonly spillRamBytes: number;
}

/** A row read as a report: its reading is the table's. slowNow: set on a card reading only (cardFit). */
export type TableFit = FitReport & Pick<FitRow, "stops" | "card"> & { readonly slowNow?: SlowNow };

/**
 * What every list and Settings show for a row: an installed model's verdict against the card's own
 * memory (the row's card), whatever other programs hold right now; the row itself otherwise. A send
 * reads the row as it is, right now. Where the server named who is in the way, the card reading
 * carries it with the spill right now (slowNow), so a list can say why the model is slower.
 */
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

// One card reading per report, so a selector that returns it keeps its identity until the next table.
const cards = new WeakMap<TableFit, TableFit>();

/** A table replaces the last one only when it is from a newer reading: a restarted server, or a later build. */
export const newerTable = (next: FitTable, last: FitTable | undefined): boolean =>
  last === undefined || next.reading.boot !== last.reading.boot || next.reading.seq > last.reading.seq;

// One report per row, so a selector that returns it keeps its identity until the next table.
const reports = new WeakMap<FitRow, TableFit>();

/** `model` at `numCtx` (already capped to the model's limit); undefined before the first table or when it has no such row. */
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

/**
 * The one way a list reads a model's row: the table at the app's context, capped to the model's own
 * limit as the server caps it, judged against the card (cardFit). Never the catalog's own fit, never
 * an uncapped context.
 */
export function rowOf(s: { readonly fitTable: FitTable | undefined; readonly models: readonly { readonly name: string; readonly maxContext?: number }[] | undefined; readonly numCtx: number }, model: string | undefined, numCtx = s.numCtx): TableFit | undefined {
  return cardFit(fitFor(s.fitTable, model, ctxFor(numCtx, s.models, model)));
}

/**
 * The table answers: memory was read and the runtime gave rows. One built before the runtime was up
 * (no rows) or on a failed GPU reading is not an answer yet; screens read it as no table.
 */
export const answers = (table: FitTable | undefined): table is FitTable => table !== undefined && table.memory.kind !== "unreadable" && table.rows.length > 0;

/** Where a row stands: in the table, not yet (no table that answers), or the table has no reading for it. */
export type RowPhase = "fresh" | "checking" | "none";
export const phaseOf = (table: FitTable | undefined, fit: TableFit | undefined): RowPhase => fit !== undefined ? "fresh" : answers(table) ? "none" : "checking";

/** Using it stops another chat's reply first. */
export const stopsChat = (fit: TableFit | undefined): boolean => (fit?.stops.length ?? 0) > 0;

/**
 * The row as a send reads it says no: not enough memory right now, with nothing a stop would free.
 * The same row and rule chat.send's admission plans with (fit/planWith on the table's reading), so a
 * model marked this way is the one the send refuses, whatever the card's own verdict.
 */
export const refusedNow = (fit: TableFit | undefined): boolean => fit !== undefined && fit.verdict === "refuse" && !stopsChat(fit);

/** A pick needs the table's row for it, one that fits, spills, or runs once another chat stops. */
export const canPick = (fit: TableFit | undefined): boolean => fit !== undefined && (fit.verdict !== "refuse" || stopsChat(fit));

/**
 * The picker's card line: the card every size is judged against ("16 GB GPU"), never what is free
 * this second; with more than one card, all of them together, as the sizes are ("2 GPUs, 18 GB").
 */
export function cardLine(m: FitMemory, whole: number | undefined): string {
  if (m.kind === "cpu") return "Runs in system memory";
  if (m.kind === "unreadable") return "GPU reading unavailable";
  if (whole === undefined) return "";
  return m.gpuCount !== undefined && m.gpuCount > 1 ? `${m.gpuCount} GPUs, ${cardGb(whole)}` : `${cardGb(whole)} GPU`;
}
