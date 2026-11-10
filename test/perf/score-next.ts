// A shuffle test on each arm's lower quartile. Reads the same Run records as stats.ts.
//
// One browser context is one observation. Repetitions of the same index are
// shuffled between arms, because the first repetition in a browser is slower
// than the second. Recorded runs show almost no variance between rounds, so a
// pair in one round tells little more than any two repetitions, and pairing
// would ask every repetition to agree. An action repeated inside a repetition
// counts once, as the mean of its instances, so a change in any instance shows.
//
// Timing noise only adds, which moves the top of a distribution and leaves the
// bottom alone, so the lower quartile is the steadier place to look.
import type { Metric, Run } from "./stats.ts";

/** "Within noise" means the row was tested and no change was seen; "not scored" means it could not be tested. */
export type Signal = "slower" | "faster" | "within noise" | "not scored";

/** Whether a verdict names a measured change. */
export function isChange(signal: Signal): boolean {
  return signal === "slower" || signal === "faster";
}
export type RowKind = "exact" | "sampled";

export interface Verdict {
  action: string;
  unit: Metric["unit"];
  kind: RowKind;
  /** Repetitions in the smaller arm. */
  repetitions: number;
  /** Lower quartile of a sampled row, median of an exact one. */
  baseValue: number;
  candidateValue: number;
  delta: number;
  percent: number | null;
  /** Two-sided; 1 when the row is exact or cannot reach the threshold. */
  p: number;
  /** The difference this job could not tell from noise. Zero for an exact row. */
  limit: number;
  signal: Signal;
  /** Why a row that cannot give a verdict cannot give one. */
  note?: string;
}

export interface ScoreOptions {
  /** Chance of a false signal on one row. */
  alpha?: number;
}

export const DEFAULT_ALPHA = 0.01;
const QUARTILE = 0.25;
const SHUFFLES = 4000;
const SIMULATION_SHUFFLES = 400;
const FRAME_MS = 1000 / 60;
/** Shifts tried by detectableChange, as a percent of the row's median. */
const SHIFT_GRID = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100, 150, 200, 300, 400];

function isMetric(value: unknown): value is Metric {
  return typeof value === "object" && value !== null
    && "action" in value && typeof value.action === "string"
    && "unit" in value && (value.unit === "ms" || value.unit === "count")
    && "samples" in value && Array.isArray(value.samples) && value.samples.every(sample => typeof sample === "number");
}

export function parseMetric(text: string): Metric {
  const value: unknown = JSON.parse(text);
  if (!isMetric(value)) throw new Error("Not a metric record");
  return value;
}

function isRun(value: unknown): value is Run {
  return typeof value === "object" && value !== null
    && "schema" in value && value.schema === 1
    && "commit" in value && typeof value.commit === "string"
    && "metrics" in value && Array.isArray(value.metrics) && value.metrics.every(isMetric);
}

export function parseRun(text: string): Run {
  const value: unknown = JSON.parse(text);
  if (!isRun(value)) throw new Error("Not a run record");
  return value;
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function quantile(values: readonly number[], q: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  const at = (sorted.length - 1) * q, lower = Math.floor(at);
  return sorted[lower]! + (sorted[Math.min(lower + 1, sorted.length - 1)]! - sorted[lower]!) * (at - lower);
}

const lowerQuartile = (values: readonly number[]) => quantile(values, QUARTILE);
const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

type Random = (limit: number) => number;

function randomFrom(seed: number): Random {
  let state = seed >>> 0;
  return limit => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor(state / 0x1_0000_0000 * limit);
  };
}

function seedFor(text: string, seed: number): number {
  let hash = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
  return hash;
}

function shuffle(values: number[], random: Random): number[] {
  for (let i = values.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [values[i], values[j]] = [values[j]!, values[i]!];
  }
  return values;
}

/** One repetition: the samples of one action inside one browser context. */
type Repetition = readonly number[];
interface PairedRow { action: string; unit: Metric["unit"]; base: Repetition[][]; candidate: Repetition[][] }
/** Repetition index, then one value per round. */
type Strata = number[][];

/** Every action runs at least once per repetition, so the rarest row gives the count. */
function repetitionsIn(run: Run): number {
  return Math.max(1, Math.min(...run.metrics.map(m => m.samples.length)));
}

/** A row whose samples do not split evenly lost or gained an instance somewhere, and which repetition it belongs to is unknown. */
function splitRepetitions(action: string, samples: readonly number[], repetitions: number): Repetition[] {
  const instances = samples.length / repetitions;
  if (!Number.isInteger(instances) || instances < 1) throw new Error(`${action}: ${samples.length} samples do not divide into ${repetitions} repetitions`);
  return Array.from({ length: repetitions }, (_, i) => samples.slice(i * instances, (i + 1) * instances));
}

function pairedRows(base: readonly Run[], candidate: readonly Run[]): PairedRow[] {
  if (base.length === 0 || base.length !== candidate.length) throw new Error("Need paired runs in both arms");
  const names = base[0]!.metrics.map(m => m.action);
  if (names.length === 0) throw new Error("No rows to score: the runs recorded no actions");
  const key = names.toSorted().join("\n");
  for (const run of [...base, ...candidate]) {
    if (run.metrics.map(m => m.action).toSorted().join("\n") !== key) throw new Error("Journey sets differ");
  }
  return names.map(action => {
    const samples = (runs: readonly Run[]) => runs.map(run => ({ metric: run.metrics.find(m => m.action === action)!, repetitions: repetitionsIn(run) }));
    const a = samples(base), b = samples(candidate);
    const unit = a[0]!.metric.unit;
    if ([...a, ...b].some(entry => entry.metric.unit !== unit)) throw new Error(`Metric units differ for ${action}`);
    const split = (arm: typeof a) => arm.map(entry => splitRepetitions(action, entry.metric.samples, entry.repetitions));
    return { action, unit, base: split(a), candidate: split(b) };
  });
}

function strataOf(arm: readonly Repetition[][]): Strata {
  const count = Math.max(...arm.map(repetitions => repetitions.length));
  return Array.from({ length: count }, (_, index) => arm.flatMap(repetitions => index < repetitions.length ? [mean(repetitions[index]!)] : []));
}

function steady(arm: Repetition[][]): boolean {
  const flat = arm.map(repetitions => repetitions.flat());
  const longest = Math.max(...flat.map(samples => samples.length));
  for (let position = 0; position < longest; position++) {
    const values = flat.flatMap(samples => position < samples.length ? [samples[position]!] : []);
    if (new Set(values).size > 1) return false;
  }
  return true;
}

/**
 * A counter with one value per position in each arm is exact, not sampled.
 * One run per arm agrees with itself whatever the counter does, so it shows nothing.
 */
function isExact(row: PairedRow): boolean {
  return row.unit === "count" && row.base.length > 1 && row.candidate.length > 1 && steady(row.base) && steady(row.candidate);
}

/**
 * Below this a difference is not worth naming. A wall-clock row stops at a
 * millisecond, which is the size of the timer's jitter. CPU time has no such
 * jitter, so it stops at a percent of the row.
 */
function smallestChange(row: Pick<PairedRow, "action" | "unit">, value: number): number {
  if (row.unit === "count") return 0;
  return isCpuRow(row.action) ? Math.max(0.05, value * 0.01) : Math.max(1, value * 0.01);
}

function isCpuRow(action: string): boolean {
  return action.includes(".cpu-");
}

function binomial(n: number, k: number): number {
  let result = 1;
  for (let i = 1; i <= k; i++) result = result * (n - k + i) / i;
  return result;
}

/** How many ways the repetitions can be dealt between the arms. */
function arrangements(base: Strata, candidate: Strata): number {
  return base.reduce((ways, values, i) => ways * binomial(values.length + (candidate[i]?.length ?? 0), values.length), 1);
}

function shuffledDifferences(base: Strata, candidate: Strata, shuffles: number, random: Random): number[] {
  const differences: number[] = [];
  for (let t = 0; t < shuffles; t++) {
    const a: number[] = [], b: number[] = [];
    base.forEach((values, i) => {
      const dealt = shuffle([...values, ...(candidate[i] ?? [])], random);
      a.push(...dealt.slice(0, values.length));
      b.push(...dealt.slice(values.length));
    });
    differences.push(Math.abs(lowerQuartile(b) - lowerQuartile(a)));
  }
  return differences;
}

function sampledVerdict(row: Pick<PairedRow, "action" | "unit">, base: Strata, candidate: Strata, alpha: number, shuffles: number, random: Random): Verdict {
  const baseValue = lowerQuartile(base.flat()), candidateValue = lowerQuartile(candidate.flat());
  const delta = candidateValue - baseValue;
  const verdict = {
    action: row.action, unit: row.unit, kind: "sampled" as const, repetitions: Math.min(base.flat().length, candidate.flat().length),
    baseValue, candidateValue, delta, percent: baseValue === 0 ? null : delta / baseValue * 100,
  };
  if (2 / arrangements(base, candidate) >= alpha) {
    return { ...verdict, p: 1, limit: Number.POSITIVE_INFINITY, signal: "not scored", note: `Only ${verdict.repetitions} repetitions per arm. More are needed before a change can be reported.` };
  }
  const nulls = shuffledDifferences(base, candidate, shuffles, random);
  const extreme = nulls.filter(value => value >= Math.abs(delta) - 1e-9).length;
  const p = (extreme + 1) / (shuffles + 1);
  const signal: Signal = p < alpha && Math.abs(delta) >= smallestChange(row, baseValue) ? (delta > 0 ? "slower" : "faster") : "within noise";
  return { ...verdict, p, limit: quantile(nulls, 1 - alpha), signal };
}

function scoreRow(row: PairedRow, alpha: number): Verdict {
  if (isExact(row)) {
    const baseValue = median(row.base.flat(2)), candidateValue = median(row.candidate.flat(2));
    const moves = row.base.flatMap((repetitions, round) => {
      const other = row.candidate[round]!.flat();
      return repetitions.flat().slice(0, other.length).map((value, i) => ({ instance: i + 1, by: other[i]! - value }));
    });
    const delta = median(moves.map(move => move.by));
    // The word follows the delta printed beside it. Moves the other way are named, never netted.
    const signal: Signal = delta > 0 ? "slower" : delta < 0 ? "faster" : "within noise";
    const against = [...new Set(moves.filter(move => move.by !== 0 && Math.sign(move.by) !== Math.sign(delta)).map(move => `instance ${move.instance} by ${move.by > 0 ? "+" : ""}${move.by}`))];
    const verdict = { action: row.action, unit: row.unit, kind: "exact" as const, repetitions: moves.length, baseValue, candidateValue, delta, percent: baseValue === 0 ? null : delta / baseValue * 100, p: 1, limit: 0, signal };
    if (!against.length) return verdict;
    return { ...verdict, note: `${delta === 0 ? "No change in the middle, but counts moved" : "Counts also moved the other way"}: ${against.join(", ")}` };
  }
  return sampledVerdict(row, strataOf(row.base), strataOf(row.candidate), alpha, SHUFFLES, randomFrom(seedFor(row.action, 0)));
}

export function scoreNext(base: readonly Run[], candidate: readonly Run[], options: ScoreOptions = {}): Verdict[] {
  const alpha = options.alpha ?? DEFAULT_ALPHA;
  return pairedRows(base, candidate).map(row => scoreRow(row, alpha));
}

/** The verdicts as the table a person reads, ending with how many rows were not scored. */
export function scoredMarkdown(verdicts: readonly Verdict[]): string {
  const unscored = verdicts.filter(v => v.signal === "not scored").length;
  return [
    "Timing is informational. A signal is a measured change, never a release failure.", "",
    "| Action | Kind | Unit | Base | Candidate | Delta | % | p | Noise limit | Repetitions | Signal |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...verdicts.map(v => `| ${v.action} | ${v.kind} | ${v.unit} | ${v.baseValue.toFixed(2)} | ${v.candidateValue.toFixed(2)} | ${v.delta.toFixed(2)} | ${v.percent?.toFixed(1) ?? "n/a"} | ${v.signal === "not scored" ? "n/a" : v.p.toFixed(4)} | ${Number.isFinite(v.limit) ? v.limit.toFixed(2) : "n/a"} | ${v.repetitions} | ${v.signal}${v.note ? `; ${v.note}` : ""} |`),
    ...unscored ? ["", `${unscored} of ${verdicts.length} rows were not scored: too few repetitions to test them.`] : [],
  ].join("\n") + "\n";
}

export interface Detectable {
  action: string;
  unit: Metric["unit"];
  kind: RowKind;
  median: number;
  /** Rate at which same-build data is reported as a change. */
  falseSignals: number;
  /** Smallest shift reported at least 9 times in 10, or null when none is. */
  percent: number | null;
  absolute: number | null;
}

export interface DetectableOptions extends ScoreOptions {
  rounds: number;
  samples: number;
  trials?: number;
  seed?: number;
}

/** A row ending at a paint moves in whole frames, so a small delay is sometimes one frame and sometimes none. */
function shifted(value: number, shift: number, frames: boolean, random: Random): number {
  if (!frames) return Math.max(0, value + shift);
  const whole = Math.floor(shift / FRAME_MS);
  const part = shift / FRAME_MS - whole;
  return value + (whole + (random(1_000_000) / 1_000_000 < part ? 1 : 0)) * FRAME_MS;
}

/**
 * Simulate jobs from same-build runs to find what the method can see. Recorded
 * repetitions are dealt into two arms without replacement, a real split of real
 * data. A job bigger than the recording is refused: redrawing a few values to
 * fill it repeats them in both arms and makes the noise look smaller than it is.
 */
export function detectableChange(base: readonly Run[], candidate: readonly Run[], options: DetectableOptions): Detectable[] {
  const alpha = options.alpha ?? DEFAULT_ALPHA;
  const trials = options.trials ?? 200;
  return pairedRows(base, candidate).map(row => {
    const runs = [...row.base, ...row.candidate];
    const middle = median(runs.flat(2));
    if (isExact(row)) {
      return { action: row.action, unit: row.unit, kind: "exact" as const, median: middle, falseSignals: 0, percent: middle === 0 ? null : 100 / middle, absolute: 1 };
    }
    const random = randomFrom(seedFor(row.action, options.seed ?? 19));
    const pools = strataOf(runs);
    const held = Math.min(...pools.map(pool => pool.length));
    if (pools.length < options.samples || held < 2 * options.rounds) {
      throw new Error(`${row.action}: the recording holds ${held} repetitions at each position in ${pools.length} positions; a ${options.rounds}x${options.samples} job needs ${2 * options.rounds} in ${options.samples}`);
    }
    const frames = row.unit === "ms" && !isCpuRow(row.action);
    const simulate = (shift: number) => {
      const a: Strata = [], b: Strata = [];
      for (let repetition = 0; repetition < options.samples; repetition++) {
        const dealt = shuffle([...pools[repetition]!], random);
        a.push(dealt.slice(0, options.rounds));
        b.push(dealt.slice(options.rounds, 2 * options.rounds).map(value => shifted(value, shift, frames, random)));
      }
      return isChange(sampledVerdict(row, a, b, alpha, SIMULATION_SHUFFLES, random).signal);
    };
    const rate = (shift: number) => {
      let hits = 0;
      for (let t = 0; t < trials; t++) if (simulate(shift)) hits++;
      return hits / trials;
    };
    const falseSignals = rate(0);
    const reference = middle > 0 ? middle : 1;
    const found = SHIFT_GRID.find(percent => rate(reference * percent / 100) >= 0.9) ?? null;
    return { action: row.action, unit: row.unit, kind: "sampled" as const, median: middle, falseSignals, percent: found, absolute: found === null ? null : reference * found / 100 };
  });
}
