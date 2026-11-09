import { expect, it } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import { currentFit, fitReading } from "./fit-state.ts";
import { fitKey } from "./store.ts";

it("PL-01: a catalog arriving after invalidation is history until fit.check answers", () => {
  const report = { ...methodSamples["fit.check"].result, verdict: "fits" as const };
  const catalog = [{ name: report.model, label: "Offered model", purpose: "Chat", recommended: true, installed: false, downloadBytes: 1, fit: report }];
  const pending = { fits: {}, fitStatus: {}, catalog };
  expect(fitReading(pending, report.model, report.numCtx)).toEqual({ report, phase: "checking" });
  expect(currentFit(pending, report.model, report.numCtx)).toBeUndefined();
  const checked = { ...pending, fits: { [fitKey(report.model, report.numCtx)]: report } };
  expect(fitReading(checked, report.model, report.numCtx).phase).toBe("fresh");
  expect(currentFit(checked, report.model, report.numCtx)).toBe(report);
});
