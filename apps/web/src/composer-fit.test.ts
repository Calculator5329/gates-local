import { expect, it } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import type { FitReport } from "@gates-local/contracts";
import { composerFit } from "./composer-fit.ts";
import { verdictOf, type Verdict } from "./format.ts";

const fits = { ...methodSamples["fit.check"].result, verdict: "fits" as const };
const refusal = { ...fits, verdict: "refuse" as const };

/** Feed the same report identities and held verdict through successive composer renders. */
function composer() {
  let held: Verdict | undefined;
  let duringLoad: FitReport | "error" | undefined;
  return (report: FitReport | "error" | undefined, loading = false) => {
    if (loading) duringLoad = report;
    const cached = report === undefined || report === "error" ? report : verdictOf(report);
    const next = composerFit(held, cached, loading, report === duringLoad);
    held = next.held;
    return next;
  };
}

it("keeps fits through a load-time refusal and ready until a later report arrives", () => {
  const show = composer();
  expect(show(fits).shown?.k).toBe("gpu");
  expect(show(fits, true).shown?.k).toBe("gpu");
  expect(show(refusal, true).shown?.k).toBe("gpu");
  const ready = show(refusal);
  expect(ready.shown?.k).toBe("gpu");
  expect(ready.held?.k).toBe("gpu");
  expect(show({ ...fits }).shown?.k).toBe("gpu");
});

it("shows a real refusal arriving after ready immediately", () => {
  const show = composer();
  show(fits);
  show(refusal, true);
  const ready = show({ ...refusal });
  expect(ready.shown?.k).toBe("no");
  expect(ready.held?.k).toBe("no");
});

it("a failed check ends the hold during or after loading", () => {
  for (const loading of [true, false]) {
    const show = composer();
    show(fits);
    show(refusal, true);
    expect(show("error", loading)).toEqual({ shown: undefined, held: undefined });
    expect(show(undefined)).toEqual({ shown: undefined, held: undefined });
  }
});

it("without a held verdict shows the cached advice while waiting for a new report", () => {
  const show = composer();
  expect(show(undefined, true).shown).toBeUndefined();
  expect(show(refusal, true).shown?.k).toBe("no");
  expect(show(refusal).shown?.k).toBe("no");
  expect(show({ ...fits }).shown?.k).toBe("gpu");
  expect(composer()(refusal).shown?.k).toBe("no");
});
