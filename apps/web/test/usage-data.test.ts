// The Usage screen's arithmetic: ranges, local days across a midnight and a
// clock change, six models and Other, colours that stay with their model,
// and the compact numbers. The time zone is set per test (Node reads TZ live).
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { colourSlots, compact, duration, rangeStart, readPrefs, usageView, writePrefs, type UsageRead } from "../src/usage-data.ts";

const HOUR = 3_600_000;
const zone = process.env["TZ"];
const day = (d: number, h = 9) => Date.UTC(2026, 10, d, h);
const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
afterEach(() => {
  if (zone === undefined) delete process.env["TZ"];
  else process.env["TZ"] = zone;
});

const row = (hour: number, model: string, promptTokens: number, completionTokens: number, replies = 1, times: Partial<Record<"decodeMs" | "decodeTokens" | "readMs" | "readTokens" | "wallMs", number>> = {}) =>
  ({ hour, model, promptTokens, completionTokens, replies, decodeMs: 0, decodeTokens: 0, readMs: 0, readTokens: 0, wallMs: 0, ...times });

describe("ranges", () => {
  it("24 h is the current hour and the 23 before it, one point each", () => {
    process.env["TZ"] = "UTC";
    const now = Date.UTC(2026, 10, 7, 14, 25);
    expect(rangeStart("24h", now, [])).toBe(Date.UTC(2026, 10, 6, 15));
    const view = usageView({ rows: [row(Date.UTC(2026, 10, 7, 14), "a:1", 10, 2), row(Date.UTC(2026, 10, 6, 14), "a:1", 99, 9)], models: ["a:1"] }, "24h", now);
    expect(view.periods).toHaveLength(24);
    expect(view.periods.at(-1)!.start).toBe(Date.UTC(2026, 10, 7, 14));
    // The hour 24 h back is outside the range.
    expect(view.totals).toMatchObject({ promptTokens: 10, completionTokens: 2 });
    expect(view.lines[0]!.prompt.at(-1)).toBe(10);
  });

  it("7 d is seven local days ending today, grouped at the viewer's midnight", () => {
    process.env["TZ"] = "America/Chicago"; // UTC-6 in November
    const now = Date.UTC(2026, 10, 8, 5, 30); // Nov 7, 23:30 local
    const since = rangeStart("7d", now, []);
    expect(since).toBe(Date.UTC(2026, 10, 1, 5)); // Nov 1 00:00 local is 05:00 UTC (CDT, before the change)
    const read: UsageRead = {
      models: ["a:1"],
      rows: [
        row(Date.UTC(2026, 10, 8, 5), "a:1", 1, 1), // Nov 7 23:00 local, still today
        row(Date.UTC(2026, 10, 7, 5), "a:1", 2, 1), // Nov 6 23:00 local
        row(Date.UTC(2026, 10, 7, 6), "a:1", 4, 1), // Nov 7 00:00 local
      ],
    };
    const view = usageView(read, "7d", now);
    expect(view.periods.map((p) => new Date(p.start).getDate())).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(view.lines[0]!.prompt.slice(-2)).toEqual([2, 5]);
  });

  it("a day with a clock change is still one point, with its 25 hours in it", () => {
    process.env["TZ"] = "America/New_York"; // clocks go back at 02:00 on Nov 1, 2026
    const now = Date.UTC(2026, 10, 3, 12);
    const view = usageView({ models: ["a:1"], rows: Array.from({ length: 25 }, (_, i) => row(Date.UTC(2026, 10, 1, 4) + i * HOUR, "a:1", 1, 0)) }, "7d", now);
    const days = view.periods.map((p) => new Date(p.start).getDate());
    expect(days).toEqual([28, 29, 30, 31, 1, 2, 3]);
    // Nov 1 runs 04:00 UTC to 05:00 UTC the next day: all 25 hours, none spilling into Nov 2.
    expect(view.lines[0]!.prompt).toEqual([0, 0, 0, 0, 25, 0, 0]);
    // and the spring change: a 23-hour day is one point too
    process.env["TZ"] = "Europe/Berlin"; // clocks go forward at 02:00 on Mar 29, 2026
    const spring = usageView({ models: ["a:1"], rows: Array.from({ length: 23 }, (_, i) => row(Date.UTC(2026, 2, 28, 23) + i * HOUR, "a:1", 1, 0)) }, "7d", Date.UTC(2026, 2, 30, 12));
    expect(spring.lines[0]!.prompt).toEqual([0, 0, 0, 0, 0, 23, 0]);
  });

  it("30 d is thirty points, and All starts on the first day used, a week at least", () => {
    process.env["TZ"] = "UTC";
    const now = Date.UTC(2026, 10, 7, 14);
    expect(usageView({ rows: [], models: [] }, "30d", now).periods).toHaveLength(30);
    expect(usageView({ rows: [], models: [] }, "all", now).periods).toHaveLength(7);
    const read = { rows: [row(Date.UTC(2026, 8, 1, 9), "a:1", 5, 5)], models: ["a:1"] };
    const all = usageView(read, "all", now);
    expect(new Date(all.periods[0]!.start).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(all.periods).toHaveLength(68);
    expect(rangeStart("all", now, [])).toBe(0);
  });

  it("no usage is the same frame: zero points, no lines, zero totals", () => {
    process.env["TZ"] = "UTC";
    const view = usageView({ rows: [], models: [] }, "7d", Date.UTC(2026, 10, 7, 14));
    expect(view.periods).toHaveLength(7);
    expect(view.lines).toEqual([]);
    expect(view.totals).toEqual({ promptTokens: 0, completionTokens: 0, replies: 0, decodeMs: 0 });
  });
});

describe("models", () => {
  const now = Date.UTC(2026, 10, 7, 14);
  const hour = Date.UTC(2026, 10, 7, 9);

  it("draws six models by tokens in the range and folds the rest into Other", () => {
    process.env["TZ"] = "UTC";
    const models = ["m1:1", "m2:1", "m3:1", "m4:1", "m5:1", "m6:1", "m7:1", "m8:1"];
    const view = usageView({ models, rows: models.map((m, i) => row(hour, m, (i + 1) * 100, i + 1)) }, "7d", now);
    expect(view.lines.map((l) => l.model)).toEqual(["m8:1", "m7:1", "m6:1", "m5:1", "m4:1", "m3:1", null]);
    const other = view.lines.at(-1)!;
    expect([other.promptTotal, other.completionTotal]).toEqual([300, 3]);
    expect(other.colour).toBe("other");
    expect(view.totals).toMatchObject({ promptTokens: 3600, completionTokens: 36, replies: 8 });
  });

  it("seven models draw six and an Other of one; six draw no Other", () => {
    process.env["TZ"] = "UTC";
    const six = ["a:1", "b:1", "c:1", "d:1", "e:1", "f:1"];
    expect(usageView({ models: six, rows: six.map((m) => row(hour, m, 1, 1)) }, "7d", now).lines.map((l) => l.model)).not.toContain(null);
    const seven = [...six, "g:1"];
    expect(usageView({ models: seven, rows: seven.map((m) => row(hour, m, 1, 1)) }, "7d", now).lines).toHaveLength(7);
  });

  it("a model keeps its colour when ranks swap, because colour follows first use", () => {
    process.env["TZ"] = "UTC";
    const models = ["a:1", "b:1", "c:1"];
    const before = usageView({ models, rows: [row(hour, "a:1", 900, 1), row(hour, "b:1", 50, 1), row(hour, "c:1", 10, 1)] }, "7d", now);
    const after = usageView({ models, rows: [row(hour, "a:1", 9, 1), row(hour, "b:1", 50, 1), row(hour, "c:1", 1000, 1)] }, "7d", now);
    const colours = (v: typeof before) => Object.fromEntries(v.lines.map((l) => [l.model, l.colour]));
    expect(before.lines.map((l) => l.model)).toEqual(["a:1", "b:1", "c:1"]);
    expect(after.lines.map((l) => l.model)).toEqual(["c:1", "b:1", "a:1"]);
    expect(colours(after)).toEqual(colours(before));
    expect(colours(before)).toEqual({ "a:1": 0, "b:1": 1, "c:1": 2 });
  });

  it("two drawn models never share a colour, even when first use wraps the palette", () => {
    const order = Array.from({ length: 12 }, (_, i) => `m${i}:1`);
    const slots = colourSlots(order, ["m0:1", "m8:1", "m3:1"]);
    expect(slots.get("m0:1")).toBe(0);
    expect(slots.get("m3:1")).toBe(3);
    expect(slots.get("m8:1")).not.toBe(0);
    expect(new Set(slots.values()).size).toBe(3);
  });
});

describe("speed", () => {
  const now = Date.UTC(2026, 10, 7, 14);

  it("is the ratio of the sums, not the mean of each reply's speed", () => {
    process.env["TZ"] = "UTC";
    // A long reply at 100 tok/s and a short one at 10 tok/s: 1010 tokens in 11 s.
    const view = usageView({ models: ["a:1"], rows: [
      row(day(7, 9), "a:1", 2000, 1000, 1, { decodeTokens: 1000, decodeMs: 10_000, readTokens: 2000, readMs: 1000 }),
      row(day(7, 10), "a:1", 50, 10, 1, { decodeTokens: 10, decodeMs: 1000, readTokens: 50, readMs: 1000 }),
    ] }, "7d", now);
    const line = view.lines[0]!;
    expect(line.speedTotal).toBeCloseTo(1010 / 11, 6);
    expect(line.readSpeedTotal).toBeCloseTo(2050 / 2, 6);
    expect(line.speed.at(-1)).toBeCloseTo(1010 / 11, 6);
    expect(view.totals.decodeMs).toBe(11_000);
    expect(view.totals.replies).toBe(2);
  });

  it("leaves a request without decode time out of the speed but counts its tokens", () => {
    process.env["TZ"] = "UTC";
    const view = usageView({ models: ["a:1"], rows: [
      row(day(7, 9), "a:1", 100, 500, 1, { decodeTokens: 500, decodeMs: 5000 }),
      row(day(7, 10), "a:1", 100, 9000, 1), // no times reported
    ] }, "7d", now);
    expect(view.lines[0]!.speedTotal).toBe(100);
    expect(view.lines[0]!.completionTotal).toBe(9500);
  });

  it("a period with no decode time is a gap, never a zero; a model with none has no speed", () => {
    process.env["TZ"] = "UTC";
    const view = usageView({ models: ["a:1", "b:1"], rows: [
      row(day(5), "a:1", 10, 100, 1, { decodeTokens: 100, decodeMs: 2000 }),
      row(day(6), "a:1", 10, 100, 1), // tokens but no time: still a gap
      row(day(7), "a:1", 10, 300, 1, { decodeTokens: 300, decodeMs: 3000 }),
      row(day(7), "b:1", 10, 10, 1),
    ] }, "7d", now);
    const a = view.lines.find((l) => l.model === "a:1")!;
    expect(a.speed).toEqual([null, null, null, null, 50, null, 100]);
    const b = view.lines.find((l) => l.model === "b:1")!;
    expect(b.speedTotal).toBeNull();
    expect(b.speed.every((v) => v === null)).toBe(true);
  });

  it("Other has no speed line", () => {
    process.env["TZ"] = "UTC";
    const models = ["a:1", "b:1", "c:1", "d:1", "e:1", "f:1", "g:1"];
    const view = usageView({ models, rows: models.map((m, i) => row(day(7), m, 1, 100 - i, 1, { decodeTokens: 100 - i, decodeMs: 1000 })) }, "7d", now);
    const other = view.lines.at(-1)!;
    expect(other.model).toBeNull();
    expect(other.speedTotal).toBeNull();
    expect(other.speed.every((v) => v === null)).toBe(true);
  });
});

describe("remembered choices", () => {

  it("the range and the Tokens / Speed switch come back as they were left", () => {
    const store = memory();
    expect(readPrefs(store)).toEqual({ range: "7d", metric: "tokens" });
    writePrefs(store, { range: "30d", metric: "speed" });
    expect(readPrefs(store)).toEqual({ range: "30d", metric: "speed" });
  });

  it("storage that refuses or holds junk gives the defaults", () => {
    expect(readPrefs({ getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } })).toEqual({ range: "7d", metric: "tokens" });
    expect(() => writePrefs({ getItem: () => null, setItem: () => { throw new Error("full"); } }, { range: "all", metric: "speed" })).not.toThrow();
    expect(readPrefs({ getItem: () => '{"range":"1y","metric":7}', setItem: () => {} })).toEqual({ range: "7d", metric: "tokens" });
  });
});

describe("durations", () => {
  it("time generating reads as minutes and hours", () => {
    expect([0, 45_000, 48 * 60_000, 3 * 3_600_000, 3 * 3_600_000 + 12 * 60_000 + 40_000].map(duration)).toEqual(["0 min", "45 s", "48 min", "3 h", "3 h 12 min"]);
  });
});

describe("compact numbers", () => {
  it("shortens like the mockup and keeps small counts exact", () => {
    expect([0, 7, 999, 1000, 1840, 40_200, 402_000, 999_999, 1_840_000, 12_300_000, 2_500_000_000].map(compact)).toEqual(["0", "7", "999", "1k", "1.84k", "40.2k", "402k", "1M", "1.84M", "12.3M", "2.5B"]);
  });
});

describe("palette", () => {
  // Graphics need 3:1 against what they sit on (WCAG 1.4.11).
  const css = readFileSync(new URL("../src/usage.css", import.meta.url), "utf8");
  const block = (marker: string) => [...(css.split(marker)[1] ?? "").split("}")[0]!.matchAll(/--u\d:(#[0-9a-f]{6})/g)].map((m) => m[1]!);

  it("eight colours for each theme, each 3:1 or better on that theme's ground", () => {
    const light = block("/* light */");
    const dark = block("/* dark */");
    expect(light).toHaveLength(8);
    expect(dark).toHaveLength(8);
    for (const c of dark) expect(ratio(c, "#000000"), c).toBeGreaterThanOrEqual(3);
    for (const c of dark) expect(ratio(c, "#0a0a0a"), c).toBeGreaterThanOrEqual(3);
    for (const c of light) expect(ratio(c, "#fcfcfc"), c).toBeGreaterThanOrEqual(3);
  });
});
