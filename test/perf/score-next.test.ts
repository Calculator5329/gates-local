import { describe, expect, it } from "vitest";
import { detectableChange, parseMetric, parseRun, scoreNext, scoredMarkdown } from "./score-next.ts";
import { metric, type Metric, type Run } from "./stats.ts";

function noise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function run(arm: "base" | "candidate", round: number, metrics: readonly Metric[]): Run {
  return {
    schema: 1, commit: "abc", round, arm, browser: "test",
    machine: { cpus: 6, memoryBytes: 1, freeBytes: 1, loadBefore: [0, 0, 0], loadAfter: [0, 0, 0] },
    fake: { firstTokenDelayMs: 40, tokenDelayMs: 8, burstTokens: 8, thinking: false, loadDelayMs: 0, longMarkdown: { tokenDelayMs: 8, burstTokens: 8 }, concurrentParallelLimit: 2 },
    metrics: [...metrics],
  };
}

/** Rounds of one action, where each sample comes from `value(round, position)`. */
function runs(arm: "base" | "candidate", rounds: number, samples: number, value: (round: number, position: number) => number, name = "open"): Run[] {
  return Array.from({ length: rounds }, (_, round) => run(arm, round + 1, [
    metric(name, "ms", Array.from({ length: samples }, (_item, position) => value(round, position))),
  ]));
}

/** Four instances of one action in each of two repetitions. */
function fourInstances(arm: "base" | "candidate", extra: (instance: number) => number, random: () => number): Run[] {
  return Array.from({ length: 4 }, (_, round) => run(arm, round + 1, [
    metric("switch", "ms", [...instances(extra, random), ...instances(extra, random)]),
    metric("anchor", "ms", [10, 11]),
  ]));
}

function instances(extra: (instance: number) => number, random: () => number): number[] {
  return [376, 358, 492, 492].map((value, instance) => value + extra(instance) + random());
}

/** A floor near 200 ms, and now and then a slow sample that only adds. */
function oneSided(random: () => number): number {
  const slow = random() < 0.2 ? 60 * random() : 0;
  return 200 + 6 * random() + slow;
}

/** A switch row that recorded `count` instances where the run had two repetitions. */
function ragged(arm: "base" | "candidate", count: number): Run[] {
  return Array.from({ length: 4 }, (_, round) => run(arm, round + 1, [
    metric("switch", "ms", Array.from({ length: count }, () => 100)), metric("open", "ms", [100, 101]),
  ]));
}

function counters(arm: "base" | "candidate", rounds: number, value: number): Run[] {
  return Array.from({ length: rounds }, (_, round) => run(arm, round + 1, [metric("commits", "count", [value, value])]));
}

/** Four runs of a counter that varies, counted `perRun` times in each. */
function varying(arm: "base" | "candidate", perRun: number, value: (round: number, position: number) => number): Run[] {
  return Array.from({ length: 4 }, (_, round) => run(arm, round + 1, [metric("thread-2000.react-renders", "count", Array.from({ length: perRun }, (_item, position) => value(round, position)))]));
}
/** Shaped like the long-thread open: the base renders the whole thread, the candidate a first screen plus however many backfill slices fit. */
const baseRenders = (round: number, position: number) => 16454 + (round + position) % 2;
const candidateRenders = (round: number, position: number) => 1135 + 97 * (3 * round + position);

describe("scoreNext", () => {
  it("reports no change between two draws from the same build", () => {
    const random = noise(11);
    const verdicts = scoreNext(runs("base", 4, 5, () => oneSided(random)), runs("candidate", 4, 5, () => oneSided(random)));
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ kind: "sampled", repetitions: 20, signal: "within noise" });
    expect(verdicts[0]!.limit).toBeGreaterThan(0);
  });

  it("gives the same answer each time for the same runs", () => {
    const random = noise(13);
    const base = runs("base", 4, 5, () => oneSided(random)), candidate = runs("candidate", 4, 5, () => oneSided(random));
    expect(scoreNext(base, candidate)).toEqual(scoreNext(base, candidate));
  });

  it("finds a known ten percent slowdown through one-sided noise", () => {
    const random = noise(23);
    const verdicts = scoreNext(runs("base", 4, 5, () => oneSided(random)), runs("candidate", 4, 5, () => oneSided(random) + 20));
    expect(verdicts[0]).toMatchObject({ signal: "slower" });
    expect(verdicts[0]!.delta).toBeGreaterThan(15);
    expect(verdicts[0]!.delta).toBeLessThan(25);
  });

  it("finds a known improvement and names its direction", () => {
    const random = noise(31);
    const verdicts = scoreNext(runs("base", 4, 5, () => oneSided(random) + 20), runs("candidate", 4, 5, () => oneSided(random)));
    expect(verdicts[0]).toMatchObject({ signal: "faster" });
  });

  it("finds a shift at the smallest job the threshold allows", () => {
    const random = noise(37);
    const verdicts = scoreNext(runs("base", 4, 2, () => 200 + 4 * random()), runs("candidate", 4, 2, () => 230 + 4 * random()));
    expect(verdicts[0]).toMatchObject({ repetitions: 8, signal: "slower" });
  });

  it("refuses a verdict when the repetitions cannot reach the threshold, however large the change", () => {
    const verdicts = scoreNext(runs("base", 4, 1, () => 200), runs("candidate", 4, 1, round => 900 + round));
    expect(verdicts[0]).toMatchObject({ repetitions: 4, signal: "not scored" });
    expect(verdicts[0]!.note).toContain("4 repetitions");
  });

  it("tells a row that was not tested from one that showed no change, in the table and its last line", () => {
    const tested = scoreNext(counters("base", 4, 12), counters("candidate", 4, 12));
    const untested = scoreNext(runs("base", 4, 1, () => 200, "open"), runs("candidate", 4, 1, () => 900, "open"));
    const text = scoredMarkdown([...tested, ...untested]);
    expect(text).toContain("| commits | exact | count | 12.00 | 12.00 | 0.00 | 0.0 | 1.0000 | 0.00 | 8 | within noise |");
    expect(text).toMatch(/\| open \| sampled \| ms \| 200\.00 \| 900\.00 \| 700\.00 \| 350\.0 \| n\/a \| n\/a \| 4 \| not scored;/);
    expect(text.trimEnd().split("\n").at(-1)).toBe("1 of 2 rows were not scored: too few repetitions to test them.");
    expect(scoredMarkdown(tested)).not.toContain("not scored");
  });

  it("ignores a consistent change too small to matter", () => {
    const verdicts = scoreNext(runs("base", 4, 4, (_, position) => 300 + position), runs("candidate", 4, 4, (_, position) => 300.5 + position));
    expect(verdicts[0]).toMatchObject({ signal: "within noise" });
  });

  it("reports a sub-millisecond change in CPU time, which has no timer jitter", () => {
    const random = noise(41);
    const verdicts = scoreNext(
      runs("base", 4, 4, () => 5 + 0.02 * random(), "open.cpu-script"),
      runs("candidate", 4, 4, () => 5.5 + 0.02 * random(), "open.cpu-script"),
    );
    expect(verdicts[0]).toMatchObject({ signal: "slower" });
  });

  it("treats repeats inside one repetition as one observation", () => {
    const random = noise(43);
    const verdicts = scoreNext(fourInstances("base", () => 0, random), fourInstances("candidate", () => 0, random));
    expect(verdicts.find(v => v.action === "switch")).toMatchObject({ repetitions: 8, signal: "within noise" });
  });

  it("sees a slowdown in only one of the instances", () => {
    const random = noise(45);
    const verdicts = scoreNext(fourInstances("base", () => 0, random), fourInstances("candidate", instance => instance === 3 ? 40 : 0, random));
    expect(verdicts.find(v => v.action === "switch")).toMatchObject({ signal: "slower" });
  });

  it("compares like repetitions, so a slow first repetition is not a change", () => {
    const random = noise(47);
    const value = (_: number, position: number) => (position === 0 ? 330 : 290) + 3 * random();
    expect(scoreNext(runs("base", 8, 2, value), runs("candidate", 8, 2, value))[0]).toMatchObject({ signal: "within noise" });
  });

  it("finds a small shift underneath a large gap between repetitions", () => {
    const random = noise(51);
    const value = (_: number, position: number) => (position === 0 ? 330 : 290) + 3 * random();
    expect(scoreNext(runs("base", 8, 2, value), runs("candidate", 8, 2, (round, position) => value(round, position) + 12))[0]).toMatchObject({ signal: "slower" });
  });

  it("calls an unchanged counter exact and reports nothing", () => {
    expect(scoreNext(counters("base", 4, 12), counters("candidate", 4, 12))[0]).toMatchObject({ kind: "exact", signal: "within noise", delta: 0, limit: 0 });
  });

  it("reports any change in an exact counter, with no noise allowance", () => {
    expect(scoreNext(counters("base", 4, 12), counters("candidate", 4, 13))[0]).toMatchObject({ kind: "exact", signal: "slower", delta: 1 });
    expect(scoreNext(counters("base", 4, 12), counters("candidate", 4, 11))[0]).toMatchObject({ kind: "exact", signal: "faster", delta: -1 });
  });

  it("treats a counter that varies between runs as sampled", () => {
    const base = Array.from({ length: 4 }, (_, round) => run("base", round + 1, [metric("frames", "count", [10 + round, 10 + round])]));
    expect(scoreNext(base, base)[0]).toMatchObject({ kind: "sampled", signal: "within noise" });
  });

  it("scores a counter that varies when each of four runs counts three times, and cannot when each counts once", () => {
    expect(scoreNext(varying("base", 1, baseRenders), varying("candidate", 1, candidateRenders))[0]).toMatchObject({ kind: "sampled", signal: "not scored" });
    const [three] = scoreNext(varying("base", 3, baseRenders), varying("candidate", 3, candidateRenders));
    expect(three).toMatchObject({ kind: "sampled", signal: "faster" });
    expect(three!.p).toBeLessThan(0.005);
  });

  it("leaves two counts per run at the edge of the threshold, even when the arms do not overlap", () => {
    expect(scoreNext(varying("base", 2, baseRenders), varying("candidate", 2, candidateRenders))[0]!.p).toBeGreaterThan(0.005);
  });

  it("does not call a counter exact from one run per arm, which cannot show it is steady", () => {
    expect(scoreNext(counters("base", 1, 66), counters("candidate", 1, 182))[0]).toMatchObject({ kind: "sampled", signal: "not scored" });
  });

  it("gives no direction to an exact counter whose moves cancel, and names them", () => {
    const base = Array.from({ length: 4 }, (_, round) => run("base", round + 1, [metric("open", "count", [10, 20])]));
    const candidate = Array.from({ length: 4 }, (_, round) => run("candidate", round + 1, [metric("open", "count", [11, 19])]));
    const [verdict] = scoreNext(base, candidate);
    expect(verdict).toMatchObject({ kind: "exact", delta: 0, signal: "within noise" });
    expect(verdict!.note).toContain("instance 1 by +1");
    expect(verdict!.note).toContain("instance 2 by -1");
  });

  it("refuses a row whose samples do not divide into the run's repetitions", () => {
    expect(() => scoreNext(ragged("base", 7), ragged("candidate", 8))).toThrow("switch: 7 samples do not divide into 2 repetitions");
  });

  it("refuses runs with nothing to score", () => {
    expect(() => scoreNext([run("base", 1, [])], [run("candidate", 1, [])])).toThrow("No rows to score");
  });

  it("refuses arms that measured different actions", () => {
    const other = [run("candidate", 1, [metric("other", "ms", [1])])];
    expect(() => scoreNext(runs("base", 1, 1, () => 1), other)).toThrow("Journey sets differ");
  });
});

describe("reading recorded runs", () => {
  it("accepts a run record", () => {
    const text = JSON.stringify(run("base", 1, [metric("open", "ms", [1, 2])]));
    expect(parseRun(text).metrics[0]).toMatchObject({ action: "open", unit: "ms" });
  });

  it("refuses a run with a bad metric", () => {
    expect(() => parseRun(JSON.stringify({ schema: 1, commit: "abc", metrics: [{ action: "open", unit: "s", samples: [] }] }))).toThrow("Not a run record");
  });

  it("refuses a metric without numeric samples", () => {
    expect(() => parseMetric(JSON.stringify({ action: "open", unit: "ms", samples: ["slow"] }))).toThrow("Not a metric record");
  });
});

describe("detectableChange", () => {
  it("names the smallest shift it would report, with few false signals", () => {
    const random = noise(59);
    const value = () => 200 + 8 * random();
    const [row] = detectableChange(runs("base", 4, 4, value, "open.cpu-task"), runs("candidate", 4, 4, value, "open.cpu-task"), { rounds: 4, samples: 4, trials: 100 });
    expect(row).toMatchObject({ kind: "sampled" });
    expect(row!.falseSignals).toBeLessThanOrEqual(0.04);
    expect(row!.percent).toBeGreaterThan(0);
    expect(row!.percent).toBeLessThanOrEqual(5);
  });

  it("says nothing can be detected when the job has too few repetitions", () => {
    const random = noise(61);
    const value = () => 200 + 8 * random();
    const [row] = detectableChange(runs("base", 4, 5, value), runs("candidate", 4, 5, value), { rounds: 2, samples: 2, trials: 50 });
    expect(row!.percent).toBeNull();
    expect(row!.falseSignals).toBe(0);
  });

  it("refuses a job bigger than the recording, which redrawing could only flatter", () => {
    const random = noise(63);
    const value = () => 200 + 8 * random();
    const options = { rounds: 4, samples: 8, trials: 10 };
    expect(() => detectableChange(runs("base", 4, 2, value), runs("candidate", 4, 2, value), options)).toThrow("holds 8 repetitions at each position");
    expect(() => detectableChange(runs("base", 2, 8, value), runs("candidate", 2, 8, value), options)).toThrow("holds 4 repetitions at each position");
  });

  it("holds a row that ends at a paint to whole frames", () => {
    // The same values twice; only the name says whether the row ends at a paint.
    const random = noise(67);
    const values = Array.from({ length: 32 }, () => 100 + 0.5 * random());
    const recorded = (arm: "base" | "candidate", name: string) => runs(arm, 4, 4, (round, position) => values[(arm === "base" ? 0 : 16) + round * 4 + position]!, name);
    const options = { rounds: 4, samples: 4, trials: 100 };
    const [painted] = detectableChange(recorded("base", "paint"), recorded("candidate", "paint"), options);
    const [cpu] = detectableChange(recorded("base", "paint.cpu-task"), recorded("candidate", "paint.cpu-task"), options);
    // A 5 percent delay is 5 ms, which a paint shows as a whole frame only now and then.
    expect(cpu!.percent).toBeLessThanOrEqual(5);
    expect(painted!.percent).toBeGreaterThanOrEqual(10);
  });

  it("gives exact counters a detectable change of one count", () => {
    const [row] = detectableChange(counters("base", 4, 50), counters("candidate", 4, 50), { rounds: 4, samples: 2 });
    expect(row).toMatchObject({ kind: "exact", falseSignals: 0, absolute: 1, percent: 2 });
  });
});
