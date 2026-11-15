// The Usage panel's arithmetic, apart from the drawing: which hours a range
// reads, the points (hours for 24 h, the viewer's local days otherwise, so a
// day with a clock change is still one point), six models and one Other,
// colours by first use, speed as a ratio of sums, and the short numbers.

export type UsageRange = "24h" | "7d" | "30d" | "all";
export type UsageMetric = "tokens" | "speed";
export const RANGES: readonly (readonly [UsageRange, string])[] = [["24h", "24 h"], ["7d", "7 d"], ["30d", "30 d"], ["all", "All"]];
export const METRICS: readonly (readonly [UsageMetric, string])[] = [["tokens", "Tokens"], ["speed", "Speed"]];

export interface UsageRow {
  readonly hour: number;
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly replies: number;
  readonly decodeMs: number;
  readonly decodeTokens: number;
  readonly readMs: number;
  readonly readTokens: number;
  readonly wallMs: number;
}
export interface UsageRead {
  readonly rows: readonly UsageRow[];
  readonly models: readonly string[];
}

export interface UsageLine {
  /** null is Other: every model past the sixth. */
  readonly model: string | null;
  /** A palette slot (0 to 7) kept by first use, or Other's neutral. */
  readonly colour: number | "other";
  readonly prompt: number[];
  readonly completion: number[];
  readonly replies: number[];
  readonly decodeMs: number[];
  readonly decodeTokens: number[];
  readonly readMs: number[];
  readonly readTokens: number[];
  /** tok/s per point; null where nothing reported a decode time (a gap), and always for Other. */
  readonly speed: (number | null)[];
  readonly promptTotal: number;
  readonly completionTotal: number;
  readonly repliesTotal: number;
  readonly speedTotal: number | null;
  readonly readSpeedTotal: number | null;
}

export interface UsageView {
  readonly hourly: boolean;
  /** Each point's start: a UTC hour, or a local midnight. */
  readonly periods: { readonly start: number }[];
  /** Drawn models by tokens in the range, then Other. */
  readonly lines: UsageLine[];
  readonly totals: { promptTokens: number; completionTokens: number; replies: number; decodeMs: number };
}

const HOUR = 3_600_000;
const PALETTE = 8;
const DAYS: Record<Exclude<UsageRange, "24h" | "all">, number> = { "7d": 7, "30d": 30 };
const DRAWN = 6;

const hourOf = (ms: number) => Math.floor(ms / HOUR) * HOUR;
const midnight = (ms: number, back = 0) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
};
const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};
const ratio = (tokens: number, ms: number) => (ms > 0 ? tokens / (ms / 1000) : null);

/** Where a range's read starts: the first hour of its first point; All reads everything. */
export function rangeStart(range: UsageRange, now: number, _rows: readonly UsageRow[]): number {
  if (range === "all") return 0;
  if (range === "24h") return hourOf(now) - 23 * HOUR;
  return midnight(now, DAYS[range] - 1);
}

function periodsFor(range: UsageRange, now: number, rows: readonly UsageRow[]): number[] {
  if (range === "24h") return Array.from({ length: 24 }, (_, i) => hourOf(now) - (23 - i) * HOUR);
  let count = range === "all" ? 7 : DAYS[range];
  if (range === "all" && rows.length > 0) {
    const first = midnight(Math.min(...rows.map((r) => r.hour)));
    const today = dayKey(now);
    let days = 1;
    for (let d = first; dayKey(d) !== today && d < now; days++) d = midnight(d, -1);
    count = Math.max(count, days);
  }
  return Array.from({ length: count }, (_, i) => midnight(now, count - 1 - i));
}

/**
 * Palette slots for the drawn models: each model's first-use place, taken
 * round the palette, so a model keeps its colour when ranks change; two drawn
 * models that land on one slot (the ninth model used and the first) part.
 */
export function colourSlots(order: readonly string[], drawn: readonly string[]): Map<string, number> {
  const rank = (m: string) => {
    const i = order.indexOf(m);
    return i < 0 ? order.length : i;
  };
  const slots = new Map<string, number>();
  const used = new Set<number>();
  for (const model of drawn.toSorted((a, b) => rank(a) - rank(b))) {
    let slot = rank(model) % PALETTE;
    while (used.has(slot) && used.size < PALETTE) slot = (slot + 1) % PALETTE;
    used.add(slot);
    slots.set(model, slot);
  }
  return slots;
}

type Sums = Omit<UsageLine, "model" | "colour" | "speed" | "promptTotal" | "completionTotal" | "repliesTotal" | "speedTotal" | "readSpeedTotal">;
const FIELDS = ["prompt", "completion", "replies", "decodeMs", "decodeTokens", "readMs", "readTokens"] as const;
const emptySums = (n: number): Sums => Object.fromEntries(FIELDS.map((f) => [f, Array.from({ length: n }, () => 0)])) as unknown as Sums;
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

function line(model: string | null, colour: number | "other", s: Sums): UsageLine {
  const speedless = model === null;
  return {
    model, colour, ...s,
    speed: s.decodeTokens.map((t, i) => (speedless ? null : ratio(t, s.decodeMs[i]!))),
    promptTotal: sum(s.prompt),
    completionTotal: sum(s.completion),
    repliesTotal: sum(s.replies),
    speedTotal: speedless ? null : ratio(sum(s.decodeTokens), sum(s.decodeMs)),
    readSpeedTotal: speedless ? null : ratio(sum(s.readTokens), sum(s.readMs)),
  };
}

export function usageView(read: UsageRead, range: UsageRange, now: number): UsageView {
  const periods = periodsFor(range, now, read.rows);
  const hourly = range === "24h";
  const index = new Map(periods.map((start, i) => [hourly ? String(start) : dayKey(start), i]));
  const byModel = new Map<string, Sums>();
  for (const r of read.rows) {
    const i = index.get(hourly ? String(r.hour) : dayKey(r.hour));
    if (i === undefined) continue;
    let s = byModel.get(r.model);
    if (s === undefined) byModel.set(r.model, (s = emptySums(periods.length)));
    s.prompt[i]! += r.promptTokens;
    s.completion[i]! += r.completionTokens;
    s.replies[i]! += r.replies;
    s.decodeMs[i]! += r.decodeMs;
    s.decodeTokens[i]! += r.decodeTokens;
    s.readMs[i]! += r.readMs;
    s.readTokens[i]! += r.readTokens;
  }
  const order = (m: string) => {
    const i = read.models.indexOf(m);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const tokens = (s: Sums) => sum(s.prompt) + sum(s.completion);
  const ranked = [...byModel].filter(([, s]) => tokens(s) > 0).toSorted(([a, x], [b, y]) => tokens(y) - tokens(x) || order(a) - order(b));
  const drawn = ranked.length > DRAWN ? ranked.slice(0, DRAWN) : ranked;
  const rest = ranked.slice(drawn.length);
  const slots = colourSlots(read.models, drawn.map(([m]) => m));
  const lines = drawn.map(([m, s]) => line(m, slots.get(m)!, s));
  if (rest.length > 0) {
    const other = emptySums(periods.length);
    for (const [, s] of rest) for (const f of FIELDS) s[f].forEach((v, i) => (other[f][i]! += v));
    lines.push(line(null, "other", other));
  }
  return {
    hourly,
    periods: periods.map((start) => ({ start })),
    lines,
    totals: {
      promptTokens: sum(lines.map((l) => l.promptTotal)),
      completionTokens: sum(lines.map((l) => l.completionTotal)),
      replies: sum(lines.map((l) => l.repliesTotal)),
      decodeMs: sum(lines.map((l) => sum(l.decodeMs))),
    },
  };
}

/** A line's figures for the range, or for one point in focus. */
export function figuresAt(l: UsageLine, at: number | null) {
  if (at === null) return { prompt: l.promptTotal, completion: l.completionTotal, replies: l.repliesTotal, speed: l.speedTotal, readSpeed: l.readSpeedTotal };
  const speedless = l.model === null;
  return {
    prompt: l.prompt[at] ?? 0,
    completion: l.completion[at] ?? 0,
    replies: l.replies[at] ?? 0,
    speed: l.speed[at] ?? null,
    readSpeed: speedless ? null : ratio(l.readTokens[at] ?? 0, l.readMs[at] ?? 0),
  };
}

/** 1.84M, 402k, 999: three significant figures, never "1000k". */
export function compact(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const units = ["k", "M", "B", "T"];
  let value = n / 1000;
  let u = 0;
  while (u < units.length - 1 && Number(value.toPrecision(3)) >= 1000) {
    value /= 1000;
    u++;
  }
  return `${Number(value.toPrecision(3))}${units[u]}`;
}

/** Time generating: "3 h 12 min", "48 min", "45 s". */
export function duration(ms: number): string {
  if (ms <= 0) return "0 min";
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const minutes = Math.floor(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export interface UsagePrefs {
  readonly range: UsageRange;
  readonly metric: UsageMetric;
}
const PREFS_KEY = "gates-local.usage";
const DEFAULTS: UsagePrefs = { range: "7d", metric: "tokens" };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/** The range and the Tokens / Speed switch as the panel was last left; defaults when storage refuses. */
export function readPrefs(storage: Storage): UsagePrefs {
  try {
    const value: unknown = JSON.parse(storage.getItem(PREFS_KEY) ?? "null");
    if (typeof value !== "object" || value === null) return DEFAULTS;
    const { range, metric } = value as Record<string, unknown>;
    if (!RANGES.some(([r]) => r === range) || !METRICS.some(([m]) => m === metric)) return DEFAULTS;
    return { range: range as UsageRange, metric: metric as UsageMetric };
  } catch {
    return DEFAULTS;
  }
}

export function writePrefs(storage: Storage, prefs: UsagePrefs): void {
  try {
    storage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // a private window may refuse; the panel keeps the choice until reload
  }
}
