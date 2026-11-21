export type UsageRange = "24h" | "7d" | "30d" | "all";
export const RANGES: readonly (readonly [UsageRange, string])[] = [["24h", "24 h"], ["7d", "7 d"], ["30d", "30 d"], ["all", "All"]];

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
  readonly model: string | null;
  readonly colour: number | "other";
  readonly prompt: number[];
  readonly completion: number[];
  readonly replies: number[];
  readonly decodeMs: number[];
  readonly decodeTokens: number[];
  readonly readMs: number[];
  readonly readTokens: number[];
  readonly wallMs: number[];
  readonly promptTotal: number;
  readonly completionTotal: number;
  readonly repliesTotal: number;
  readonly speedTotal: number | null;
  readonly speedLow: number | null;
  readonly speedHigh: number | null;
  readonly readSpeedTotal: number | null;
}

export interface UsageView {
  readonly hourly: boolean;
  readonly periods: { readonly start: number }[];
  readonly lines: UsageLine[];
  readonly totals: { promptTokens: number; completionTokens: number; replies: number; wallMs: number };
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

type Sums = Pick<UsageLine, (typeof FIELDS)[number]>;
const FIELDS = ["prompt", "completion", "replies", "decodeMs", "decodeTokens", "readMs", "readTokens", "wallMs"] as const;
const emptySums = (n: number): Sums => Object.fromEntries(FIELDS.map((f) => [f, Array.from({ length: n }, () => 0)])) as unknown as Sums;
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

interface Spread { low: number; high: number }

function line(model: string | null, colour: number | "other", s: Sums, spread: Spread | undefined): UsageLine {
  const speedless = model === null;
  return {
    model, colour, ...s,
    promptTotal: sum(s.prompt),
    completionTotal: sum(s.completion),
    repliesTotal: sum(s.replies),
    speedTotal: speedless ? null : ratio(sum(s.decodeTokens), sum(s.decodeMs)),
    speedLow: speedless ? null : spread?.low ?? null,
    speedHigh: speedless ? null : spread?.high ?? null,
    readSpeedTotal: speedless ? null : ratio(sum(s.readTokens), sum(s.readMs)),
  };
}

export function usageView(read: UsageRead, range: UsageRange, now: number): UsageView {
  const periods = periodsFor(range, now, read.rows);
  const hourly = range === "24h";
  const index = new Map(periods.map((start, i) => [hourly ? String(start) : dayKey(start), i]));
  const byModel = new Map<string, Sums>();
  const spreads = new Map<string, Spread>();
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
    s.wallMs[i]! += r.wallMs;
    const speed = ratio(r.decodeTokens, r.decodeMs);
    if (speed === null) continue;
    const seen = spreads.get(r.model);
    spreads.set(r.model, seen === undefined ? { low: speed, high: speed } : { low: Math.min(seen.low, speed), high: Math.max(seen.high, speed) });
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
  const lines = drawn.map(([m, s]) => line(m, slots.get(m)!, s, spreads.get(m)));
  if (rest.length > 0) {
    const other = emptySums(periods.length);
    for (const [, s] of rest) for (const f of FIELDS) s[f].forEach((v, i) => (other[f][i]! += v));
    lines.push(line(null, "other", other, undefined));
  }
  return {
    hourly,
    periods: periods.map((start) => ({ start })),
    lines,
    totals: {
      promptTokens: sum(lines.map((l) => l.promptTotal)),
      completionTokens: sum(lines.map((l) => l.completionTotal)),
      replies: sum(lines.map((l) => l.repliesTotal)),
      wallMs: sum(lines.map((l) => sum(l.wallMs))),
    },
  };
}

// why: one figure hides hours far apart (102 and 3.9 read as 14), so those show slowest–fastest
export function speedText(l: Pick<UsageLine, "speedTotal" | "speedLow" | "speedHigh">): string {
  if (l.speedLow !== null && l.speedHigh !== null && l.speedHigh / l.speedLow > 1.5) return `${Math.round(l.speedLow)}–${Math.round(l.speedHigh)}`;
  return l.speedTotal === null ? "–" : String(Math.round(l.speedTotal));
}

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
}
const PREFS_KEY = "gates-local.usage";
const DEFAULTS: UsagePrefs = { range: "7d" };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export function readPrefs(storage: Storage): UsagePrefs {
  try {
    const value: unknown = JSON.parse(storage.getItem(PREFS_KEY) ?? "null");
    if (typeof value !== "object" || value === null) return DEFAULTS;
    // why: a value stored before the Tokens / Speed switch went also holds `metric`, read past it
    const { range } = value as Record<string, unknown>;
    if (!RANGES.some(([r]) => r === range)) return DEFAULTS;
    return { range: range as UsageRange };
  } catch {
    return DEFAULTS;
  }
}

export function writePrefs(storage: Storage, prefs: UsagePrefs): void {
  // external: a private browser window may refuse the write, so the choice lasts until reload
  try {
    storage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}
