// How a screen reads a model's row from the fit table: at the app's context,
// capped to the model's own limit as the server caps it, and never from a
// catalog entry's own estimate.
import { expect, it } from "vitest";
import type { FitTable } from "@gates-local/contracts";
import { phaseOf, rowOf } from "./fit-table.ts";

const row = (model: string, numCtx: number, verdict: "fits" | "spills" | "refuse") =>
  ({ model, numCtx, verdict, needVramBytes: 1, freeVramBytes: 2, spillRamBytes: 0, source: "estimate", stops: [] }) as const;
const table = (...rows: ReturnType<typeof row>[]): FitTable =>
  ({ reading: { boot: "b", seq: 1, measuredAt: 0 }, memory: { kind: "gpu", freeBytes: 2, usableBytes: 1 }, rows }) as unknown as FitTable;

it("an 8k-capped model at a 16k app context reads its 8k row, the one the server built for it", () => {
  const t = table(row("small:1", 8192, "fits"));
  const models = [{ name: "small:1", maxContext: 8192 }];
  expect(rowOf({ fitTable: t, models, numCtx: 16384 }, "small:1")?.numCtx).toBe(8192);
  // a model with no limit reads the context asked for
  expect(rowOf({ fitTable: table(row("big:1", 16384, "spills")), models: [], numCtx: 16384 }, "big:1")?.verdict).toBe("spills");
});

it("a row is fresh in the table, checking before the first table, and none when the table has no reading for it", () => {
  const t = table(row("a:1", 16384, "fits"));
  const s = { fitTable: t, models: [], numCtx: 16384 };
  expect(phaseOf(t, rowOf(s, "a:1"))).toBe("fresh");
  expect(phaseOf(t, rowOf(s, "missing:1"))).toBe("none");
  expect(phaseOf(undefined, rowOf({ ...s, fitTable: undefined }, "a:1"))).toBe("checking");
});
