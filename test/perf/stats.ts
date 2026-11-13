export interface Metric {
  action: string;
  unit: "ms" | "count";
  samples: number[];
  median: number;
  p95: number;
}

export interface Run {
  schema: 1;
  commit: string;
  round: number;
  arm: "base" | "candidate";
  machine: { cpus: number; memoryBytes: number; freeBytes: number; loadBefore: number[]; loadAfter: number[] };
  browser: string;
  fake: { firstTokenDelayMs: number; tokenDelayMs: number; burstTokens: number; thinking: false; loadDelayMs: number; longMarkdown: { tokenDelayMs: number; burstTokens: number }; concurrentParallelLimit?: number };
  metrics: Metric[];
  only?: readonly string[];
  workload?: { hoverDwellMs: number; pasteCharacters: number; settleFrames: number; parallelTokenDelayMs: number; parallelBurstTokens: number; clipboard: string; voice: string };
}

/** Nearest-rank quantiles; small-sample p95 is descriptive, often the maximum. */
export function quantile(values: readonly number[], p: number): number {
  if (!values.length || values.some(v => !Number.isFinite(v) || v < 0)) throw new Error("Expected finite, nonnegative samples");
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
}

export function metric(action: string, unit: Metric["unit"], samples: number[]): Metric {
  return { action, unit, samples, median: quantile(samples, 0.5), p95: quantile(samples, 0.95) };
}

function signedMedian(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

export interface Change {
  action: string;
  unit: Metric["unit"];
  base: Metric;
  candidate: Metric;
  delta: number;
  percent: number | null;
  noiseFloor: number;
  interval95: [number, number];
  tooNoisy: boolean;
  signal: "slower" | "faster" | "within noise";
}

/** The actions one build measured. Every round of a build must measure the same ones. */
function actions(runs: Run[]): string[] {
  const names = (run: Run) => run.metrics.map(m => m.action).toSorted();
  const first = names(runs[0]!);
  for (const run of runs) if (names(run).join("\n") !== first.join("\n")) throw new Error("Journey sets differ");
  return first;
}

/**
 * Actions only one build measured. A release that moves or removes a screen
 * changes the journey, so these are listed beside the comparison and the
 * actions both builds have are still compared.
 */
export function unpaired(base: Run[], candidate: Run[]): { base: string[]; candidate: string[] } {
  const a = actions(base), b = actions(candidate);
  return { base: a.filter(name => !b.includes(name)), candidate: b.filter(name => !a.includes(name)) };
}

/** Pair whole rounds, never pretend frames or keystrokes are independent runs. */
export function compare(base: Run[], candidate: Run[]): Change[] {
  if (base.length < 4 || base.length !== candidate.length) throw new Error("Need at least four paired rounds");
  const inCandidate = actions(candidate);
  const shared = actions(base).filter(name => inCandidate.includes(name));
  if (shared.length === 0) throw new Error("No journey was measured on both builds");
  return base[0]!.metrics.filter(m => shared.includes(m.action)).map(first => {
    const rows = (runs: Run[]) => runs.map(r => {
      const row = r.metrics.find(m => m.action === first.action)!;
      if (row.unit !== first.unit) throw new Error("Metric units differ");
      return row;
    });
    const a = rows(base), b = rows(candidate);
    const allA = metric(first.action, first.unit, a.flatMap(m => m.samples));
    const allB = metric(first.action, first.unit, b.flatMap(m => m.samples));
    const differences = a.map((m, i) => b[i]!.median - m.median);
    const delta = signedMedian(differences);
    const repeats = [a, b].flatMap(arm => arm.slice(1).map((m, i) => Math.abs(m.median - arm[i]!.median)));
    // Separate within-round jitter from drift only with enough samples in
    // every round. Sparse rounds retain pooled spread, including singletons.
    const perRound = [...a, ...b].every(row => row.samples.length >= 3);
    const within = [a, b].map((arm, i) => {
      const pooledMedian = [allA, allB][i]!.median;
      return quantile(arm.flatMap(row => row.samples.map(v => Math.abs(v - (perRound ? row.median : pooledMedian)))), 0.95);
    });
    const noiseFloor = Math.max(first.unit === "ms" ? 2 : 1, quantile(repeats, 0.95), within[0]! + within[1]!);
    let seed = 19;
    const bootstrap = Array.from({ length: 2000 }, () => signedMedian(differences.map(() => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      // Low LCG bits cycle when the round count is a power of two. Scale
      // the full unsigned value so four draws need not be one permutation.
      return differences[Math.floor(seed / 0x1_0000_0000 * differences.length)]!;
    }))).toSorted((x, y) => x - y);
    const interval95: [number, number] = [bootstrap[49]!, bootstrap[1949]!];
    const tooNoisy = noiseFloor > Math.max(first.unit === "ms" ? 10 : 1, allA.median * 0.2);
    const signal = delta > noiseFloor && interval95[0] > 0 ? "slower"
      : delta < -noiseFloor && interval95[1] < 0 ? "faster" : "within noise";
    return { action: first.action, unit: first.unit, base: allA, candidate: allB, delta, percent: allA.median === 0 ? null : delta / allA.median * 100, noiseFloor, interval95, tooNoisy, signal };
  });
}
