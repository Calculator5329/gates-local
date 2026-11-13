import { describe, expect, it } from "vitest";
import { compare, metric, unpaired, type Run } from "./stats.ts";

function run(round: number, samples: number[]): Run {
  return { schema: 1, commit: "a".repeat(40), round, arm: "base", browser: "fixture", machine: { cpus: 1, memoryBytes: 1, freeBytes: 1, loadBefore: [], loadAfter: [] }, fake: { firstTokenDelayMs: 40, tokenDelayMs: 8, burstTokens: 8, thinking: false, loadDelayMs: 0, longMarkdown: { tokenDelayMs: 12, burstTokens: 4 } }, metrics: [metric("paint", "ms", samples)] };
}
const withAction = (r: Run, action: string): Run => ({ ...r, metrics: [...r.metrics, metric(action, "ms", [5])] });
describe("informational comparison diagnostic probes", () => {
  it("keeps identical timings within measured noise", () => {
    const runs = [100, 110, 98, 108, 101].map((v, i) => run(i, [v, v + 1, v + 2]));
    expect(compare(runs, runs)[0]).toMatchObject({ signal: "within noise", delta: 0, noiseFloor: 12 });
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
    expect(() => compare(runs, noisy.map(r => ({ ...r, metrics: [] })))).toThrow("No journey was measured on both builds");
  });
  it("pairs the actions both builds have and names the ones only one has", () => {
    // A release moves or removes a screen: the rest of the journey still compares.
    const base = [100, 110, 98, 108].map((v, i) => withAction(run(i, [v, v + 1, v + 2]), "settings-old-page"));
    const candidate = [400, 410, 398, 408].map((v, i) => withAction(run(i, [v, v + 1, v + 2]), "new-popup"));
    const changes = compare(base, candidate);
    expect(changes.map(c => c.action)).toEqual([base[0]!.metrics[0]!.action]);
    expect(changes[0]).toMatchObject({ signal: "slower", delta: 300 });
    expect(unpaired(base, candidate)).toEqual({ base: ["settings-old-page"], candidate: ["new-popup"] });
    expect(unpaired(base, base)).toEqual({ base: [], candidate: [] });
  });
  it("still refuses rounds of one build that measured different actions", () => {
    const base = [100, 110, 98, 108].map((v, i) => run(i, [v]));
    const uneven = base.map((r, i) => i === 2 ? { ...r, metrics: [...r.metrics, metric("extra", "ms", [1])] } : r);
    expect(() => compare(base, uneven)).toThrow("Journey sets differ");
    expect(() => unpaired(uneven, base)).toThrow("Journey sets differ");
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
  it("keeps a four-round verdict symmetric when the comparison is reversed", () => {
    const base = Array.from({ length: 4 }, (_, i) => run(i, [100]));
    const candidate = [104, 104.4, 213.3, 214].map((value, i) => run(i, [value]));
    const forward = compare(base, candidate)[0]!;
    const reverse = compare(candidate, base)[0]!;
    expect(forward.delta).toBeCloseTo(58.85);
    expect(reverse.delta).toBeCloseTo(-forward.delta);
    expect([forward.signal, reverse.signal]).toEqual(["within noise", "within noise"]);
  });
  it("separates shared drift from jitter at five rounds of three samples", () => {
    const base = [80, 90, 100, 110, 120].map((value, i) => run(i, [value - 1, value, value + 1]));
    const candidate = base.map((r, i) => run(i, r.metrics[0]!.samples.map(value => value * 1.2)));
    expect(compare(base, candidate)[0]).toMatchObject({ signal: "slower", delta: 20, noiseFloor: 12 });
    expect(compare(candidate, base)[0]).toMatchObject({ signal: "faster", delta: -20, noiseFloor: 12 });
  });
  it.each([1, 2])("keeps pooled jitter when each round has %i samples", count => {
    const base = [40, 50, 60, 70].map((value, i) => run(i, Array.from({ length: count }, (_, j) => value + j * 2)));
    const candidate = base.map((r, i) => run(i, r.metrics[0]!.samples.map(value => value + 20)));
    expect(compare(base, candidate)[0]).toMatchObject({ signal: "within noise", delta: 20, noiseFloor: 40 });
  });
  it("keeps pooled jitter for both builds when only one round is sparse", () => {
    const base = [40, 50, 60, 70].map((value, i) => run(i, [value, value + 1, value + 2]));
    const candidate = base.map((r, i) => run(i, r.metrics[0]!.samples.map(value => value + 20).slice(0, i === 0 ? 2 : 3)));
    expect(compare(base, candidate)[0]).toMatchObject({ signal: "within noise", delta: 20, noiseFloor: 40 });
  });
});
