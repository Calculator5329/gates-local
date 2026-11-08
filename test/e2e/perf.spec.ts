/// <reference lib="dom" />
// Performance budgets on the production build. Each budget sits a little
// above the number measured on Ethan's machine (2026-11-07, Chromium,
// 1440x900, the fake Ollama at 12 ms a token); the measured value is in the
// comment beside it. Every test also logs what it measured.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { Page } from "@playwright/test";
import { ROOT } from "./env.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

const BUDGET = {
  firstPaintMs: 120, // measured 76 and 84 ms
  readyMs: 180, // measured 113 and 116 ms (connected, runtime ready, composer enabled)
  longTaskMs: 50, // brief: no long task over 50 ms; measured none at all
  // p95 handler time per keydown/input event while streaming; measured 0.6 ms
  keyHandlerMs: 16,
  // p95 keydown/input duration while streaming: Event Timing's input
  // timestamp to the paint after the handlers, so input delay counts. Three
  // 60 Hz frames. Measured 24 ms in three runs (idle typing 24-40 ms); input
  // delay 0.2-0.3 ms and processing 0.6 ms of that. The rest, handlers to
  // paint, is not broken down further here.
  keyP95Ms: 50,
  jsGzipKb: 130, // measured 120.6 KB
  cssGzipKb: 9, // measured 8.1 KB
};

const report = (name: string, value: number, unit: string) => {
  test.info().annotations.push({ type: "measured", description: `${name}: ${value.toFixed(1)} ${unit}` });
  process.stdout.write(`[perf] ${name}: ${value.toFixed(1)} ${unit}\n`);
};

/** Long tasks, slow input events and a frame counter, from the first byte on. */
function observe(): void {
  const w = window as unknown as { glLong: number[]; glEvents: SlowEvent[]; glFrames: number; glKeys: number };
  w.glLong = [];
  w.glEvents = [];
  w.glFrames = 0;
  w.glKeys = 0;
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) w.glLong.push(e.duration);
  }).observe({ type: "longtask", buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries() as PerformanceEventTiming[]) {
      w.glEvents.push({
        name: e.name,
        start: e.startTime,
        duration: e.duration,
        delay: e.processingStart - e.startTime,
        processing: e.processingEnd - e.processingStart,
      });
    }
  }).observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
  // the denominator: Event Timing reports only events of 16 ms or more
  const count = () => {
    w.glKeys++;
  };
  window.addEventListener("keydown", count, { capture: true });
  window.addEventListener("input", count, { capture: true });
  // the real rAF, so a test that swaps the page's rAF still counts frames
  const raf = window.requestAnimationFrame.bind(window);
  const tick = () => {
    w.glFrames++;
    raf(tick);
  };
  raf(tick);
}

/**
 * An input event of 16 ms or more. duration runs from the input's timestamp
 * to the next paint after its handlers; delay is the wait before the
 * handlers start; processing is the handlers.
 */
interface SlowEvent {
  name: string;
  start: number;
  duration: number;
  delay: number;
  processing: number;
}

/** The client's test counters: glPerf in apps/web/src/session.ts, glRows in apps/web/src/Thread.tsx. */
interface Probe {
  glPerf?: { deltas: number; flushes: number };
  glRows?: { renders: Record<string, number>; bustMemo?: boolean };
}

const readLong = () => (window as unknown as { glLong: number[] }).glLong;
/** Key events since the last clearEvents, read once the observer has delivered the last of them. */
const readKeys = async () => {
  // entries arrive after the paint that ends them, in an observer task
  await new Promise((r) => setTimeout(r, 250));
  const w = window as unknown as { glEvents: SlowEvent[]; glKeys: number; glSince: number };
  return { events: w.glEvents.filter((e) => e.start >= w.glSince), dispatched: w.glKeys };
};
const clearEvents = () => {
  const w = window as unknown as { glEvents: SlowEvent[]; glKeys: number; glSince: number };
  w.glEvents = [];
  w.glKeys = 0;
  w.glSince = performance.now();
};
/** Block the main thread for ms in its own task: proves the long-task observer is live before a zero counts. */
const busy = (ms: number) =>
  setTimeout(() => {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      // spin
    }
  });
const isKey = (e: SlowEvent) => e.name === "keydown" || e.name === "input";

/** The p-th percentile, nearest rank. */
const pct = (xs: number[], p: number) => {
  const s = xs.toSorted((a, b) => a - b);
  return s.length === 0 ? 0 : (s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] ?? 0);
};

/**
 * keydown and input events, with every dispatched event the observer did not
 * report counted as 0: Event Timing leaves out events under 16 ms, so a 0
 * here means "under 16 ms", and a percentile of 0 means the same.
 */
function keyStats({ events, dispatched }: { events: SlowEvent[]; dispatched: number }) {
  const keys = events.filter(isKey);
  const pad = (f: (e: SlowEvent) => number) => [...keys.map(f), ...Array.from({ length: Math.max(0, dispatched - keys.length) }, () => 0)];
  return {
    dispatched,
    slow: keys.length,
    p95: pct(pad((e) => e.duration), 0.95),
    p95Delay: pct(pad((e) => e.delay), 0.95),
    p95Processing: pct(pad((e) => e.processing), 0.95),
    maxDuration: Math.max(0, ...keys.map((e) => e.duration)),
  };
}

function reportKeys(label: string, k: ReturnType<typeof keyStats>) {
  report(`${label} keydown+input events`, k.dispatched, "events");
  report(`${label} events of 16 ms or more`, k.slow, "events");
  report(`${label} p95 duration (input to paint)`, k.p95, "ms");
  report(`${label} p95 input delay`, k.p95Delay, "ms");
  report(`${label} p95 processing`, k.p95Processing, "ms");
  report(`${label} slowest duration`, k.maxDuration, "ms");
}

/**
 * Types into the focused field one key every 40 ms of wall time, without
 * waiting for the page to handle the previous key. pressSequentially waits
 * for each key's handling, so its keys never land behind a busy main thread;
 * a person's keys do.
 */
async function typeFreely(page: Page, text: string): Promise<void> {
  const sent: Promise<void>[] = [];
  for (const ch of text) {
    sent.push(page.keyboard.press(ch));
    await new Promise((r) => setTimeout(r, 40));
  }
  await Promise.all(sent);
}

/** The W-08 gate: the 95th percentile key event, input to paint, inside the budget. */
const keysWithinBudget = (k: ReturnType<typeof keyStats>) => k.dispatched >= 20 && k.p95 <= BUDGET.keyP95Ms;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(observe);
});

test("cold load: first paint and time to a ready composer", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const t = await page.evaluate(() => ({
    fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? Number.NaN,
    ready: performance.now(),
  }));
  report("first contentful paint", t.fcp, "ms");
  report("ready composer", t.ready, "ms");
  expect(t.fcp).toBeLessThan(BUDGET.firstPaintMs);
  expect(t.ready).toBeLessThan(BUDGET.readyMs);
});

/**
 * Streams one reply at 4 ms a token (several tokens to a frame) and returns
 * the client's counters plus the most store flushes seen in one animation
 * frame. window.glPerf is the client's own counter object
 * (apps/web/src/session.ts); each write to flushes is stamped with the frame
 * it happened in.
 */
async function streamFlushes(page: Page, open: (hash?: string) => Promise<void>) {
  await open();
  await waitReady(page);
  await stack.scenario("models", { tokenDelayMs: 4 });
  await page.evaluate(() => {
    const w = window as unknown as { glPerf: { deltas: number; flushes: number }; glFrames: number; glFlushFrames: number[] };
    w.glFlushFrames = [];
    let n = 0;
    Object.defineProperty(w.glPerf, "flushes", {
      configurable: true,
      get: () => n,
      set: (v: number) => {
        n = v;
        w.glFlushFrames.push(w.glFrames);
      },
    });
    w.glPerf.deltas = 0;
    w.glFrames = 0;
  });
  await sendMessage(page, "Stream something");
  await expect(page.locator(".turn.a .md").last()).toContainText("so streaming takes a", { timeout: 10_000 });
  const r = await page.evaluate(() => {
    const w = window as unknown as { glPerf: { deltas: number; flushes: number }; glFrames: number; glFlushFrames: number[] };
    const per = new Map<number, number>();
    for (const f of w.glFlushFrames) per.set(f, (per.get(f) ?? 0) + 1);
    return { deltas: w.glPerf.deltas, flushes: w.glPerf.flushes, frames: w.glFrames, maxPerFrame: Math.max(0, ...per.values()) };
  });
  report("deltas", r.deltas, "tokens");
  report("flushes", r.flushes, "renders");
  report("frames", r.frames, "frames");
  report("most flushes in one frame", r.maxPerFrame, "flushes");
  return r;
}

/** The W-09 flush gate: a real stream of many tokens, never two flushes in one frame. */
const oneFlushPerFrame = (r: { deltas: number; flushes: number; maxPerFrame: number }) => r.deltas > 50 && r.flushes > 0 && r.maxPerFrame <= 1;

test("streaming flushes at most once in any frame", async ({ page, open }) => {
  const r = await streamFlushes(page, open);
  expect(r.flushes).toBeLessThan(r.deltas);
  expect(oneFlushPerFrame(r), JSON.stringify(r)).toBe(true);
});

test("negative control: a flush per task instead of per frame fails the flush gate", async ({ page, open }) => {
  // the app's rAF becomes a zero-delay timeout; observe() keeps the real one for its frame count
  await page.addInitScript(() => {
    window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(performance.now()), 0);
    window.cancelAnimationFrame = (id) => window.clearTimeout(id);
  });
  const r = await streamFlushes(page, open);
  expect(oneFlushPerFrame(r), JSON.stringify(r)).toBe(false);
});

/** Renders of the 6 seeded rows from the caret showing until well into the reply; bust turns the control on. */
async function seededRenders(page: Page, open: (hash?: string) => Promise<void>, thread: string | null, bust: boolean) {
  // window.glRows: the row-render test flag in apps/web/src/Thread.tsx
  await page.addInitScript((b) => {
    (window as unknown as Probe).glRows = { renders: {}, bustMemo: b };
  }, bust);
  await open(`#thread=${thread ?? ""}`);
  await waitReady(page);
  await expect(page.locator(".tl .turn")).toHaveCount(6);
  const seeded = await page.evaluate(() => Object.keys((window as unknown as Probe).glRows?.renders ?? {}));
  expect(seeded).toHaveLength(6);
  await stack.scenario("models", { tokenDelayMs: 30 });
  await sendMessage(page, "Stream beside the old turns");
  const live = page.locator(".turn.a").last();
  await expect(live.locator(".caret")).toBeVisible();
  const before = await page.evaluate(() => {
    const w = window as unknown as Probe;
    if (w.glRows) w.glRows.renders = {};
    return w.glPerf?.flushes ?? 0;
  });
  // well into the reply, and still streaming when the count is read
  await expect(live.locator(".md")).toContainText("keeps every reply deterministic");
  const renders = await page.evaluate((ids) => ids.reduce((a, id) => a + ((window as unknown as Probe).glRows?.renders[id] ?? 0), 0), seeded);
  await expect(live.locator(".caret")).toBeVisible();
  const flushes = (await page.evaluate(() => (window as unknown as Probe).glPerf?.flushes ?? 0)) - before;
  report(`seeded row renders while streaming${bust ? " (memo busted)" : ""}`, renders, "renders");
  report("flushes in the same window", flushes, "flushes");
  expect(flushes).toBeGreaterThan(5);
  await expect(page.locator(".caret")).toHaveCount(0, { timeout: 10_000 });
  return renders;
}

test.describe("finished turns while a reply streams", () => {
  test.use({ seed: 6 });

  test("do not re-render", async ({ page, open, seededThread }) => {
    expect(await seededRenders(page, open, seededThread, false)).toBe(0);
  });

  test("negative control: rows handed a fresh message each token fail the render gate", async ({ page, open, seededThread }) => {
    expect(await seededRenders(page, open, seededThread, true)).toBeGreaterThan(0);
  });
});

test.describe("a 400-message thread", () => {
  test.use({ seed: 400 });
  test("opens and scrolls with no long task over 50 ms", async ({ page, open, seededThread }) => {
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    await expect(page.locator(".tl .turn")).toHaveCount(400);
    const tl = page.locator(".tl");
    await tl.evaluate((el) => el.scrollTo({ top: 0 }));
    await page.waitForTimeout(200);
    await tl.evaluate((el) => el.scrollTo({ top: el.scrollHeight / 2 }));
    await page.waitForTimeout(200);
    await tl.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await page.waitForTimeout(300);
    const long = await page.evaluate(readLong);
    report("longest task", Math.max(0, ...long), "ms");
    report("long tasks", long.length, "count");
    expect(Math.max(0, ...long)).toBeLessThanOrEqual(BUDGET.longTaskMs);

    // the observer must see a task it should: a 70 ms spin shows up
    await page.evaluate(busy, 70);
    await expect.poll(() => page.evaluate(() => Math.max(0, ...(window as unknown as { glLong: number[] }).glLong))).toBeGreaterThanOrEqual(60);
  });
});

test("typing during a stream: p95 key event, input to paint, inside the budget", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const ta = page.locator("#ta");
  const TYPED = "typing while the reply streams in";

  // idle baseline: the same typing with nothing streaming
  await ta.focus();
  await page.evaluate(clearEvents);
  await typeFreely(page, TYPED);
  await expect(ta).toHaveValue(TYPED);
  const idle = keyStats(await page.evaluate(readKeys));
  reportKeys("idle", idle);
  await ta.fill("");

  // slow tokens so the stream outlasts the typing and the control after it
  await stack.scenario("models", { tokenDelayMs: 120 });
  await sendMessage(page, "A slow reply please");
  await expect(page.locator(".caret")).toBeVisible();
  await ta.focus();
  await page.evaluate(clearEvents);
  await typeFreely(page, TYPED);
  await expect(page.locator(".caret")).toBeVisible();
  await expect(ta).toHaveValue(TYPED);
  const stream = keyStats(await page.evaluate(readKeys));
  reportKeys("stream", stream);
  expect(keysWithinBudget(stream), JSON.stringify(stream)).toBe(true);
  expect(stream.p95Processing).toBeLessThanOrEqual(BUDGET.keyHandlerMs);

  // negative control: the main thread busy in back-to-back 100 ms tasks, so
  // each key waits for the task it lands in before its handlers start. The
  // handlers stay as fast as before; the gate must still fail.
  await ta.fill("");
  await ta.focus();
  await page.evaluate(clearEvents);
  await page.evaluate(() => {
    const w = window as unknown as { glBusy: boolean };
    w.glBusy = true;
    const slice = () => {
      if (!w.glBusy) return;
      const end = performance.now() + 100;
      while (performance.now() < end) {
        // spin
      }
      setTimeout(slice);
    };
    setTimeout(slice);
  });
  await typeFreely(page, "a shorter burst");
  await page.evaluate(() => {
    (window as unknown as { glBusy: boolean }).glBusy = false;
  });
  await expect(ta).toHaveValue("a shorter burst");
  await expect(page.locator(".caret")).toBeVisible();
  const delayed = keyStats(await page.evaluate(readKeys));
  reportKeys("stream + 100 ms delay control", delayed);
  expect(keysWithinBudget(delayed), JSON.stringify(delayed)).toBe(false);
  expect(delayed.p95Delay).toBeGreaterThanOrEqual(50);
});

test("bundle size", () => {
  const dir = path.join(ROOT, "apps/web/dist/assets");
  const size = (ext: string) =>
    readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .reduce((a, f) => a + gzipSync(readFileSync(path.join(dir, f))).length, 0) / 1024;
  const js = size(".js");
  const css = size(".css");
  report("js gzip", js, "KB");
  report("css gzip", css, "KB");
  expect(js).toBeLessThan(BUDGET.jsGzipKb);
  expect(css).toBeLessThan(BUDGET.cssGzipKb);
});
