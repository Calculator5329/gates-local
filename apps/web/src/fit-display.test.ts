import { expect, it } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import { createFitDisplay } from "./fit-display.ts";

const fits = { ...methodSamples["fit.check"].result, verdict: "fits" as const };
const refusal = { ...fits, verdict: "refuse" as const };

it("returns the earlier report across surfaces and releases it for a distinct post-load answer", () => {
  const display = createFitDisplay();
  expect(display("chat@16k", fits, false)).toBe(fits);
  expect(display("chat@16k", refusal, true)).toBe(fits);
  expect(display("chat@16k", refusal, true)).toBe(fits);
  expect(display("chat@16k", refusal, false)).toBe(fits);
  const later = { ...refusal };
  expect(display("chat@16k", later, false)).toBe(later);
  expect(display("other@16k", refusal, true)).toBe(refusal);
});

it("uses the earlier catalog reading on first opening during a load, and a check error clears it", () => {
  const display = createFitDisplay();
  expect(display("chat@16k", refusal, true, fits)).toBe(fits);
  expect(display("chat@16k", "error", true, fits)).toBeUndefined();
  expect(display("chat@16k", undefined, false)).toBeUndefined();
});

it("does not lend a closed panel's reading to a missing check outside a load", () => {
  const display = createFitDisplay();
  display("chat@64k", refusal, false);
  expect(display("chat@64k", undefined, false)).toBeUndefined();
});
