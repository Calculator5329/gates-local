/// <reference lib="dom" />
// Performance budgets on the production build. Each budget sits a little
// above the number measured on Ethan's machine (2026-11-07, Chromium,
// 1440x900, the fake Ollama at 12 ms a token); the measured value is in the
// comment beside it. Every test also logs what it measured.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { ROOT } from "./env.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

const BUDGET = {
  firstPaintMs: 120, // measured 76 and 84 ms
  readyMs: 180, // measured 113 and 116 ms (connected, runtime ready, composer enabled)
  longTaskMs: 50, // brief: no long task over 50 ms; measured none at all
  // One frame of our own handler time per key event (processingEnd minus
  // processingStart), measured 1.7 ms while streaming. The full Event Timing
  // duration runs to the next paint and was 32-40 ms in headless Chromium
  // both while streaming and idle, so it measures the browser, not the app.
  keyHandlerMs: 16,
  jsGzipKb: 130, // measured 120.6 KB
  cssGzipKb: 9, // measured 8.1 KB
};

const report = (name: string, value: number, unit: string) => {
  test.info().annotations.push({ type: "measured", description: `${name}: ${value.toFixed(1)} ${unit}` });
  process.stdout.write(`[perf] ${name}: ${value.toFixed(1)} ${unit}\n`);
};

/** Long tasks and slow input events, from the first byte on. */
function observe(): void {
  const w = window as unknown as { glLong: number[]; glEvents: SlowEvent[]; glFrames: number };
  w.glLong = [];
  w.glEvents = [];
  w.glFrames = 0;
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) w.glLong.push(e.duration);
  }).observe({ type: "longtask", buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries() as PerformanceEventTiming[]) {
      w.glEvents.push({ name: e.name, duration: e.duration, processing: e.processingEnd - e.processingStart });
    }
  }).observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
  const tick = () => {
    w.glFrames++;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** An input event of 16 ms or more: duration runs to the next paint, processing is our handlers. */
interface SlowEvent {
  name: string;
  duration: number;
  processing: number;
}

const readLong = () => (window as unknown as { glLong: number[] }).glLong;
const readEvents = () => (window as unknown as { glEvents: SlowEvent[] }).glEvents;
const clearEvents = () => {
  (window as unknown as { glEvents: SlowEvent[] }).glEvents = [];
};
/** Block the main thread for ms in its own task: proves the long-task observer is live before a zero counts. */
const busy = (ms: number) =>
  setTimeout(() => {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      // spin
    }
  });
const isKey = (e: SlowEvent) => /^key|^input|^beforeinput/.test(e.name);

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

test("streaming flushes at most once per frame", async ({ page, open }) => {
  await open();
  await waitReady(page);
  // window.glPerf: the client's own counters (apps/web/src/session.ts)
  await page.evaluate(() => {
    const w = window as unknown as { glPerf?: { deltas: number; flushes: number }; glFrames: number };
    if (w.glPerf) {
      w.glPerf.deltas = 0;
      w.glPerf.flushes = 0;
    }
    w.glFrames = 0;
  });
  await sendMessage(page, "Stream something");
  await expect(page.locator(".turn.a .md").last()).toContainText("so streaming takes a", { timeout: 10_000 });
  const r = await page.evaluate(() => {
    const w = window as unknown as { glPerf?: { deltas: number; flushes: number }; glFrames: number };
    return { ...w.glPerf, frames: w.glFrames };
  });
  report("deltas", r.deltas ?? 0, "tokens");
  report("flushes", r.flushes ?? 0, "renders");
  report("frames", r.frames, "frames");
  expect(r.deltas).toBeGreaterThan(50);
  expect(r.flushes).toBeLessThanOrEqual(r.frames);
  expect(r.flushes).toBeLessThan(r.deltas ?? 0);
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

test("typing during a stream stays under one frame per key", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const ta = page.locator("#ta");

  // idle baseline: the same typing with nothing streaming
  await ta.pressSequentially("typing with nothing streaming", { delay: 25 });
  const idle = (await page.evaluate(readEvents)).filter(isKey);
  report("idle slowest key, to paint", Math.max(0, ...idle.map((e) => e.duration)), "ms");
  report("idle slowest key, handlers", Math.max(0, ...idle.map((e) => e.processing)), "ms");
  await ta.fill("");

  await stack.scenario("models", { tokenDelayMs: 30 });
  await sendMessage(page, "A slow reply please");
  await expect(page.locator(".writing")).toBeVisible();
  await page.evaluate(clearEvents);
  await ta.pressSequentially("typing while the reply streams in", { delay: 25 });
  await expect(page.locator(".writing")).toBeVisible();
  const slow = (await page.evaluate(readEvents)).filter(isKey);
  report("stream slowest key, to paint", Math.max(0, ...slow.map((e) => e.duration)), "ms");
  report("stream slowest key, handlers", Math.max(0, ...slow.map((e) => e.processing)), "ms");
  expect(slow.filter((e) => e.processing > BUDGET.keyHandlerMs)).toEqual([]);

  // the measure must catch a slow handler: a 30 ms keydown listener shows up
  await page.evaluate(() =>
    document.addEventListener("keydown", () => {
      const end = performance.now() + 30;
      while (performance.now() < end) {
        // spin
      }
    }),
  );
  await ta.press("x");
  await expect.poll(async () => Math.max(0, ...(await page.evaluate(readEvents)).filter(isKey).map((e) => e.processing))).toBeGreaterThanOrEqual(25);
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
