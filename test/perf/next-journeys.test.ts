import { describe, expect, it } from "vitest";
import { NEXT_DEFAULT, nextJourneys } from "./next-journeys.ts";

describe("nextJourneys", () => {
  it("runs every group the spec implements by default", () => {
    expect(nextJourneys(NEXT_DEFAULT)).toEqual(["startup", "send", "threads", "parallel", "clipboard", "voice", "queue", "reconnect"]);
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
