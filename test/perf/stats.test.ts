import { describe, expect, it } from "vitest";
import { compare, metric, type Run } from "./stats.ts";

function run(round: number, samples: number[]): Run {
  return { schema: 1, commit: "a".repeat(40), round, arm: "base", browser: "fixture", machine: { cpus: 1, memoryBytes: 1, freeBytes: 1, loadBefore: [], loadAfter: [] }, fake: { firstTokenDelayMs: 40, tokenDelayMs: 8, burstTokens: 8, thinking: false, loadDelayMs: 0, longMarkdown: { tokenDelayMs: 12, burstTokens: 4 } }, metrics: [metric("paint", "ms", samples)] };
}
describe("informational comparison diagnostic probes", () => {
  it("keeps identical timings within measured noise", () => {
    const runs = [100, 110, 98, 108, 101].map((v, i) => run(i, [v, v + 1, v + 2]));
    expect(compare(runs, runs)[0]).toMatchObject({ signal: "within noise", delta: 0, noiseFloor: 20 });
  });
  it("identifies a repeatable slowdown and its reverse", () => {
    const runs = [100, 110, 98, 108, 101].map((v, i) => run(i, [v, v + 1, v + 2]));
    const slow = runs.map((r, i) => run(i, r.metrics[0]!.samples.map(v => v + 300)));
    expect(compare(runs, slow)[0]).toMatchObject({ signal: "slower", delta: 300 });
    expect(compare(slow, runs)[0]).toMatchObject({ signal: "faster", delta: -300 });
  });
  it("does not invent confidence when rounds disagree or an action is missing", () => {
    const runs = [100, 100, 100, 100, 100].map((v, i) => run(i, [v]));
    const noisy = [60, 180, 90, 190, 160].map((v, i) => run(i, [v]));
    expect(compare(runs, noisy)[0]).toMatchObject({ signal: "within noise", tooNoisy: true });
    expect(() => compare(runs, noisy.map(r => ({ ...r, metrics: [] })))).toThrow("Journey sets differ");
  });
  it("includes within-round jitter when round medians happen to be steady", () => {
    const base = Array.from({ length: 4 }, (_, i) => run(i, [40, 70]));
    const candidate = Array.from({ length: 4 }, (_, i) => run(i, [60, 90]));
    expect(compare(base, candidate)[0]).toMatchObject({ signal: "within noise", delta: 20, noiseFloor: 60, tooNoisy: true });
  });
  it("allows for sample variation on both sides of a difference", () => {
    const base = Array.from({ length: 4 }, (_, i) => run(i, [40, 60]));
    const candidate = Array.from({ length: 4 }, (_, i) => run(i, [65, 85]));
    expect(compare(base, candidate)[0]).toMatchObject({ signal: "within noise", delta: 25, noiseFloor: 40 });
  });
  it("resamples four rounds instead of repeating a single permutation", () => {
    const base = Array.from({ length: 4 }, (_, i) => run(i, [100]));
    const candidate = [123, 123, 120, 99].map((value, i) => run(i, [value]));
    const result = compare(base, candidate)[0]!;
    expect(result.interval95[0]).toBeLessThan(0);
    expect(result.signal).toBe("within noise");
  });
});
