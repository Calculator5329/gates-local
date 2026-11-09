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
  fake: { firstTokenDelayMs: number; tokenDelayMs: number; burstTokens: number; thinking: false; loadDelayMs: number; longMarkdown: { tokenDelayMs: number; burstTokens: number } };
  metrics: Metric[];
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
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
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

/** Pair whole rounds, never pretend frames or keystrokes are independent runs. */
export function compare(base: Run[], candidate: Run[]): Change[] {
  if (base.length < 4 || base.length !== candidate.length) throw new Error("Need at least four paired rounds");
  const keys = base[0]!.metrics.map(m => m.action).toSorted().join("\n");
  for (const run of [...base, ...candidate]) {
    if (run.metrics.map(m => m.action).toSorted().join("\n") !== keys) throw new Error("Journey sets differ");
  }
  return base[0]!.metrics.map(first => {
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
    // Round medians conceal phase jitter. Allow both arms to vary in opposite
    // directions; their individual p95 spreads add in a measured difference.
    const within = [allA, allB].map(arm => quantile(arm.samples.map(v => Math.abs(v - arm.median)), 0.95));
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
