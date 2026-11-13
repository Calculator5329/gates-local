// The server's fit table: every model at every offered context from one GPU reading, pushed as
// fit.changed. The client keeps the last one and reads every fit value on screen from it; it asks
// for no single fit and holds no verdict of its own.
import type { FitReport, FitRow, FitTable } from "@gates-local/contracts";
import { ctxFor } from "./format.ts";

/** A row read as a report: its reading is the table's. */
export type TableFit = FitReport & Pick<FitRow, "stops" | "card">;

/**
 * What every list and Settings show for a row: an installed model's verdict against the card's own
 * memory (the row's card), whatever other programs hold right now; the row itself otherwise. A send
 * reads the row as it is, right now.
 */
export function cardFit(fit: TableFit | undefined): TableFit | undefined {
  if (fit?.card === undefined) return fit;
  let report = cards.get(fit);
  if (report === undefined) {
    const { shortfallBytes: _rightNow, card, ...rest } = fit;
    report = { ...rest, ...card };
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

/** A pick needs the table's row for it, one that fits, spills, or runs once another chat stops. */
export const canPick = (fit: TableFit | undefined): boolean => fit !== undefined && (fit.verdict !== "refuse" || stopsChat(fit));
