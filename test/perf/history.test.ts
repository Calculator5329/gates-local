import { describe, expect, it } from "vitest";
import { addRelease, parseScored, type HistoryRow } from "./history.ts";

function row(action: string, unit: HistoryRow["unit"], candidateValue: number, signal: HistoryRow["signal"] = "within noise"): HistoryRow {
  return { action, unit, kind: unit === "count" ? "exact" : "sampled", candidateValue, signal };
}

const first = addRelease("", "v1", [row("cold-composer", "ms", 287.4), row("cold-composer.cpu-task", "ms", 61.26), row("cold-composer.react-renders", "count", 214), row("open.frame-max", "ms", 33), row("open.style-recalcs", "count", 14)]);

describe("addRelease", () => {
  it("starts a history with a time table and a work table", () => {
    expect(first).toContain("## Time");
    expect(first).toContain("| Action | v1 |");
    expect(first).toContain("| cold-composer (ms) | 287 |");
    expect(first).toContain("| cold-composer.cpu-task (ms) | 61.3 |");
    expect(first.split("## Work")[1]).toContain("| cold-composer.react-renders (count) | 214 |");
  });

  it("leaves out rows a person does not read", () => {
    expect(first).not.toContain("frame-max");
    expect(first).not.toContain("style-recalcs");
  });

  it("adds a column and keeps what was there", () => {
    const next = addRelease(first, "v2", [row("cold-composer", "ms", 260.2), row("cold-composer.react-renders", "count", 190)]);
    expect(next).toContain("| Action | v1 | v2 |");
    expect(next).toContain("| cold-composer (ms) | 287 | 260 |");
    expect(next).toContain("| cold-composer.react-renders (count) | 214 | 190 |");
  });

  it("leaves a blank for a row a release did not measure, and for a row new in a release", () => {
    const next = addRelease(first, "v2", [row("cold-composer", "ms", 260), row("reconnect", "ms", 330)]);
    expect(next).toContain("| cold-composer.cpu-task (ms) | 61.3 |  |");
    expect(next).toContain("| reconnect (ms) |  | 330 |");
  });

  it("prints a count that varied between runs as a quartile, marked, never as an exact count", () => {
    const varied: HistoryRow = { ...row("queue-send-2.layouts", "count", 3.75), kind: "sampled" };
    const next = addRelease(first, "v2", [varied, row("cold-composer.react-renders", "count", 1458)]);
    expect(next).toContain("| queue-send-2.layouts (count) |  | ~3.8 |");
    expect(next).toContain("| cold-composer.react-renders (count) | 214 | 1458 |");
    expect(next).toContain("~ marks a count that varied");
  });

  it("names a measured change beside the number", () => {
    const next = addRelease(first, "v2", [row("cold-composer", "ms", 330, "slower")]);
    expect(next).toContain("| cold-composer (ms) | 287 | 330 (slower) |");
  });

  it("refuses a release it already has", () => {
    expect(() => addRelease(first, "v1", [])).toThrow("already has v1");
  });
});

describe("parseScored", () => {
  it("reads the verdicts", () => {
    expect(parseScored(JSON.stringify({ verdicts: [row("a", "ms", 1)] }))).toHaveLength(1);
  });

  it("drops the words from a build compared with itself, where any signal is false", () => {
    const scored = { commits: { base: "abc", candidate: "abc" }, verdicts: [row("a", "ms", 1, "slower")] };
    expect(parseScored(JSON.stringify(scored))[0]).toMatchObject({ signal: "within noise" });
    expect(parseScored(JSON.stringify({ ...scored, commits: { base: "abc", candidate: "def" } }))[0]).toMatchObject({ signal: "slower" });
  });

  it("refuses something else", () => {
    expect(() => parseScored(JSON.stringify({ verdicts: [{ action: "a" }] }))).toThrow("Not a scored result");
  });
});
