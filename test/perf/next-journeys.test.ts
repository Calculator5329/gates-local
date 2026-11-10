import { describe, expect, it } from "vitest";
import { NEXT_DEFAULT, nextJourneys, repetitionPlan } from "./next-journeys.ts";

describe("repetitionPlan", () => {
  it("counts three times per run, so a varying counter has three strata of four against four over four rounds", () => {
    expect(repetitionPlan(2, 2)).toEqual(["timed", "timed", "counters", "counters", "counters"]);
  });

  it("profiles once, in the first round", () => {
    expect(repetitionPlan(1, 1)).toEqual(["timed", "counters", "counters", "counters", "profile"]);
  });
});

describe("nextJourneys", () => {
  it("runs the priority groups by default, unchanged by the picker group", () => {
    expect(nextJourneys(NEXT_DEFAULT)).toEqual(["startup", "send", "threads", "parallel", "clipboard", "voice", "queue", "reconnect"]);
  });

  it("runs the typing group only when named", () => {
    expect(nextJourneys(NEXT_DEFAULT)).not.toContain("typing");
    expect(nextJourneys("typing,send")).toEqual(["typing", "send"]);
  });

  it("runs the picker group only when named, because its replies would shift every later group", () => {
    expect(nextJourneys("picker,threads")).toEqual(["picker", "threads"]);
  });

  it("refuses first-run by name instead of skipping it", () => {
    expect(() => nextJourneys("threads,first-run")).toThrow("next.spec.ts has no first-run journey");
  });

  it("refuses the priority shorthand, which includes first-run", () => {
    expect(() => nextJourneys("priority")).toThrow("next.spec.ts has no first-run journey");
  });

  it("refuses desktop-launch by name", () => {
    expect(() => nextJourneys("desktop-launch")).toThrow("next.spec.ts has no desktop-launch journey");
  });
});
