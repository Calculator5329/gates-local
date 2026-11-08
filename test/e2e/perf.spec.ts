/// <reference lib="dom" />
// Performance budgets on the production build. Each budget sits a little
// above the number measured on the maintainer's Linux machine (2026-11-07, Chromium,
// 1440x900, the fake Ollama at 12 ms a token); the measured value is in the
// comment beside it. Every test also logs what it measured.
//
// The two timing gates (cold load, typing during a stream) pass when one of
// up to TRIES tries is inside the budget. A slower app slows every try; a
// busy machine slows some. Measured 2026-11-07 at load average 17-25 on 20
// cores: 3 of 9 timing checks failed, all on the time from the handlers to
// the paint (input delay at most 1.4 ms, processing at most 0.8 ms), and the
// next try passed. The handler-time check holds on every try.
import { readdirSync, readFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { Page } from "@playwright/test";
import { ROOT, appUrl } from "./env.ts";
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
  // paint, is not broken down further here. The gate also needs no long
  // task over longTaskMs while the keys go in (keysWithinBudget).
  keyP95Ms: 50,
  jsGzipKb: 130, // measured 120.6 KB
  cssGzipKb: 9, // measured 8.1 KB
};

/** Tries per timing gate: the gate passes when one try is inside the budget. */
const TRIES = 3;

const report = (name: string, value: number, unit: string) => {
  test.info().annotations.push({ type: "measured", description: `${name}: ${value.toFixed(1)} ${unit}` });
  process.stdout.write(`[perf] ${name}: ${value.toFixed(1)} ${unit}\n`);
};

/** The machine's load when a timing gate starts, so a reader can weigh a slow number. */
const reportLoad = () => report(`machine load average, 1 min, ${cpus().length} cores`, loadavg()[0] ?? 0, "");

/** Long tasks, slow input events and a frame counter, from the first byte on. */
function observe(): void {
  const w = window as unknown as { glLong: number[]; glLongAt: [number, number][]; glEvents: SlowEvent[]; glFrames: number; glKeys: number };
  w.glLong = [];
  w.glLongAt = [];
  w.glEvents = [];
  w.glFrames = 0;
  w.glKeys = 0;
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      w.glLong.push(e.duration);
      w.glLongAt.push([e.startTime, e.duration]);
    }
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
  // The typed field's inputs, at capture: no handler of the page can stop
  // one before this sees it, and an input on another element does not count.
  // endKeys closes the window at the last one. A task that input's handlers
  // queue starts after its dispatch task ends, so it falls outside the window
  // whether the stamp is taken before or after those handlers.
  window.addEventListener(
    "input",
    (e) => {
      const f = window as unknown as { glField?: EventTarget | null; glFieldInputs?: number; glLastInput?: number };
      if (e.target !== f.glField) return;
      f.glFieldInputs = (f.glFieldInputs ?? 0) + 1;
      f.glLastInput = performance.now();
    },
    { capture: true },
  );
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
/**
 * Key events and the longest task that overlaps the typing (clearEvents to
 * the last key's input), read once the observers have delivered the last of
 * them. A task that starts after the last input, such as one that input
 * queued or one during the wait below, does not count.
 */
const readKeys = async () => {
  // entries arrive after the paint that ends them, in an observer task
  await new Promise((r) => setTimeout(r, 250));
  const w = window as unknown as { glEvents: SlowEvent[]; glLongAt: [number, number][]; glKeys: number; glSince: number; glUntil: number };
  const longest = Math.max(0, ...w.glLongAt.filter(([s, d]) => s <= w.glUntil && s + d >= w.glSince).map(([, d]) => d));
  return { events: w.glEvents.filter((e) => e.start >= w.glSince && e.start <= w.glUntil), dispatched: w.glKeys, longest };
};
/** Start a typing window on the focused field. */
const clearEvents = () => {
  const w = window as unknown as {
    glEvents: SlowEvent[];
    glKeys: number;
    glSince: number;
    glUntil: number;
    glField?: EventTarget | null;
    glFieldInputs?: number;
    glLastInput?: number;
  };
  w.glEvents = [];
  w.glKeys = 0;
  w.glSince = performance.now();
  w.glUntil = Number.POSITIVE_INFINITY;
  w.glField = document.activeElement;
  w.glFieldInputs = 0;
  w.glLastInput = undefined;
};
/**
 * End the typing window at the field's last input (now, if nothing was
 * typed). typed is the number of inputs the test sent to the field: if a
 * different number arrived, the window cannot know where the typing ended,
 * so it throws instead of closing early or late. Call it once every key is
 * in and before anything else types into the field.
 */
const endKeys = (typed: number) => {
  const w = window as unknown as { glUntil: number; glFieldInputs?: number; glLastInput?: number };
  const seen = w.glFieldInputs ?? 0;
  if (seen !== typed) throw new Error(`endKeys: ${seen} of ${typed} typed inputs reached the field`);
  w.glUntil = w.glLastInput ?? performance.now();
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
function keyStats({ events, dispatched, longest }: { events: SlowEvent[]; dispatched: number; longest: number }) {
  const keys = events.filter(isKey);
  const pad = (f: (e: SlowEvent) => number) => [...keys.map(f), ...Array.from({ length: Math.max(0, dispatched - keys.length) }, () => 0)];
  return {
    dispatched,
    slow: keys.length,
    p95: pct(pad((e) => e.duration), 0.95),
    p95Delay: pct(pad((e) => e.delay), 0.95),
    p95Processing: pct(pad((e) => e.processing), 0.95),
    maxDuration: Math.max(0, ...keys.map((e) => e.duration)),
    longestTask: longest,
  };
}

function reportKeys(label: string, k: ReturnType<typeof keyStats>) {
  report(`${label} keydown+input events`, k.dispatched, "events");
  report(`${label} events of 16 ms or more`, k.slow, "events");
  report(`${label} p95 duration (input to paint)`, k.p95, "ms");
  report(`${label} p95 input delay`, k.p95Delay, "ms");
  report(`${label} p95 processing`, k.p95Processing, "ms");
  report(`${label} slowest duration`, k.maxDuration, "ms");
  report(`${label} longest task`, k.longestTask, "ms");
}

/**
 * Types into the focused field one key every 40 ms of wall time, without
 * waiting for the page to handle the previous key. pressSequentially waits
 * for each key's handling, so its keys never land behind a busy main thread;
 * a person's keys do.
 */
async function typeFreely(page: Page, text: string): Promise<void> {
  const sent: Promise<void>[] = [];
  for (const [i, ch] of [...text].entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, 40));
    sent.push(page.keyboard.press(ch));
  }
  await Promise.all(sent);
}

/**
 * The W-08 gate: the 95th percentile key event, input to paint, inside the
 * budget, and no long task over the long-task budget while the keys go in.
 * Event Timing counts from the key's timestamp. A person's key is stamped
 * when it is pressed, but Playwright's keys are sometimes stamped only once
 * the main thread is free: in about one run in five, every key of a burst
 * sent during back-to-back 100 ms tasks showed 1-2 ms of input delay. The
 * long-task leg sees the busy main thread in those runs too.
 */
const keysWithinBudget = (k: ReturnType<typeof keyStats>) =>
  k.dispatched >= 20 && k.p95 <= BUDGET.keyP95Ms && k.longestTask <= BUDGET.longTaskMs;

// The stream test's control fails both legs at once, so it cannot show that
// each leg works alone; this does.
test("the key gate fails on slow keys alone, on a long task alone, and on too few keys", () => {
  const fast = { dispatched: 33, slow: 0, p95: 16, p95Delay: 1, p95Processing: 1, maxDuration: 16, longestTask: 0 };
  expect(keysWithinBudget(fast)).toBe(true);
  expect(keysWithinBudget({ ...fast, p95: 80 })).toBe(false);
  expect(keysWithinBudget({ ...fast, longestTask: 100 })).toBe(false);
  expect(keysWithinBudget({ ...fast, dispatched: 19 })).toBe(false);
});

test("the typing window: a long task after the last key does not count, one across the first key does", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await page.evaluate(clearEvents);
  await page.evaluate(endKeys, 0);
  // made-up entries through the real readKeys filter; nothing real is that long here
  await page.evaluate(() => {
    const w = window as unknown as { glLongAt: [number, number][]; glUntil: number };
    w.glLongAt.push([w.glUntil + 50, 400]);
  });
  expect((await page.evaluate(readKeys)).longest).toBeLessThan(400);
  await page.evaluate(() => {
    const w = window as unknown as { glLongAt: [number, number][]; glSince: number };
    w.glLongAt.push([w.glSince - 10, 400]);
  });
  expect((await page.evaluate(readKeys)).longest).toBe(400);
});

// PF2-01: a task the last key's input queues starts after that input and
// before the test gets control back; it is not the typing's.
test("the typing window ends at the last key's input, not when the test resumes", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const KEYS = "abc";
  await page.locator("#ta").focus();
  await page.evaluate(clearEvents);
  await page.evaluate((n) => {
    let seen = 0;
    window.addEventListener(
      "input",
      () => {
        seen++;
        if (seen === n)
          setTimeout(() => {
            const end = performance.now() + 150;
            while (performance.now() < end) {
              // spin
            }
          });
      },
      { capture: true },
    );
  }, KEYS.length);
  await typeFreely(page, KEYS);
  await expect(page.locator("#ta")).toHaveValue(KEYS);
  await page.evaluate(endKeys, KEYS.length);
  const k = await page.evaluate(readKeys);
  // the observer saw the task, so the zero below is not a dead observer
  expect(await page.evaluate(() => (window as unknown as { glLongAt: [number, number][] }).glLongAt.some(([, d]) => d >= 140))).toBe(true);
  expect(k.longest).toBeLessThan(140);
});

// PF3-01: the end is the typed field's last input, even when a handler of
// the page stops that input; an input elsewhere does not move it; a typed
// input that never arrived stops the test instead of closing the window early.
test("the typing window's end: a stopped input still counts, an input elsewhere does not move it, a missing one fails", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const KEYS = "abc";
  const ta = page.locator("#ta");
  await ta.focus();
  await page.evaluate(clearEvents);
  // a handler on the field stops the last key's input before it bubbles, and notes its timestamp
  await page.evaluate((n) => {
    const w = window as unknown as { glFinalAt?: number };
    let seen = 0;
    document.querySelector("#ta")?.addEventListener("input", (e) => {
      seen++;
      if (seen !== n) return;
      w.glFinalAt = e.timeStamp;
      e.stopPropagation();
    });
  }, KEYS.length);
  await typeFreely(page, KEYS);
  await expect(ta).toHaveValue(KEYS);
  await page.evaluate(endKeys, KEYS.length);
  const ends = () =>
    page.evaluate(() => {
      const w = window as unknown as { glUntil: number; glFinalAt: number };
      return { until: w.glUntil, finalAt: w.glFinalAt };
    });
  const first = await ends();
  expect(first.until, "the window ends at or after the stopped last input").toBeGreaterThanOrEqual(first.finalAt);
  // an input on another element after the typing
  await page.evaluate(() => {
    const other = document.createElement("input");
    document.body.append(other);
    other.dispatchEvent(new Event("input", { bubbles: true }));
    other.remove();
  });
  await page.evaluate(endKeys, KEYS.length);
  expect((await ends()).until, "an input elsewhere does not move the end").toBe(first.until);
  await expect(page.evaluate(endKeys, KEYS.length + 1)).rejects.toThrow("3 of 4 typed inputs reached the field");
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(observe);
});

/** First contentful paint and the time the composer is ready, on a page that has just been opened. */
async function coldTimes(page: Page) {
  await waitReady(page);
  return page.evaluate(() => ({
    fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? Number.NaN,
    ready: performance.now(),
  }));
}
const coldWithinBudget = (t: { fcp: number; ready: number }) => t.fcp < BUDGET.firstPaintMs && t.ready < BUDGET.readyMs;

test("cold load: first paint and time to a ready composer", async ({ page, open, browser }) => {
  reportLoad();
  await open();
  const tries = [await coldTimes(page)];
  // each later try is a fresh browser context, so nothing is cached from the try before
  while (tries.length < TRIES && !coldWithinBudget(tries[tries.length - 1]!)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" });
    try {
      const p = await ctx.newPage();
      const errors: string[] = [];
      p.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      p.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      await p.addInitScript(() => localStorage.setItem("gates-local.first-run-done", "1"));
      await p.goto(appUrl());
      tries.push(await coldTimes(p));
      expect(errors, "console errors").toEqual([]);
    } finally {
      await ctx.close();
    }
  }
  tries.forEach((t, i) => {
    report(`first contentful paint (try ${i + 1})`, t.fcp, "ms");
    report(`ready composer (try ${i + 1})`, t.ready, "ms");
  });
  expect(tries.some(coldWithinBudget), JSON.stringify(tries)).toBe(true);
});

/**
 * Streams one reply at 4 ms a token (several tokens to a frame) and returns
 * the client's counters plus the most store flushes seen in one animation
 * frame. window.glPerf is the client's own counter object
 * (apps/web/src/session.ts); each write to flushes is stamped with the frame
 * it happened in, and counted when it ran outside an animation-frame
 * callback (a flush from a socket event, such as the terminal one).
 */
async function streamFlushes(page: Page, open: (hash?: string) => Promise<void>, terminalFlush = false) {
  await open();
  await waitReady(page);
  await stack.scenario("models", { tokenDelayMs: 4 });
  await page.evaluate((flag) => {
    const w = window as unknown as FlushProbe;
    // the control's regression (apps/web/src/session.ts): one extra publish at the done event
    w.glPerf.terminalFlush = flag;
    w.glFlushFrames = [];
    w.glOutsideFrame = 0;
    // the app looks requestAnimationFrame up on each call; observe() kept the real one for its frame count
    const raf = window.requestAnimationFrame.bind(window);
    let inFrame = false;
    window.requestAnimationFrame = (cb) =>
      raf((t) => {
        inFrame = true;
        try {
          cb(t);
        } finally {
          inFrame = false;
        }
      });
    let n = 0;
    Object.defineProperty(w.glPerf, "flushes", {
      configurable: true,
      get: () => n,
      set: (v: number) => {
        n = v;
        w.glFlushFrames.push(w.glFrames);
        if (!inFrame) w.glOutsideFrame++;
      },
    });
    w.glPerf.deltas = 0;
    w.glFrames = 0;
  }, terminalFlush);
  await sendMessage(page, "Stream something");
  // read once the reply has finished: a flush at the terminal event counts too (WF-05)
  await expect(page.locator(".turn.a.done")).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator(".writing")).toHaveCount(0);
  await expect(page.locator(".turn.a.done .md")).toContainText("so streaming takes a");
  const r = await page.evaluate(() => {
    const w = window as unknown as FlushProbe;
    const per = new Map<number, number>();
    for (const f of w.glFlushFrames) per.set(f, (per.get(f) ?? 0) + 1);
    return { deltas: w.glPerf.deltas, flushes: w.glPerf.flushes, frames: w.glFrames, maxPerFrame: Math.max(0, ...per.values()), outsideFrame: w.glOutsideFrame };
  });
  report("deltas", r.deltas, "tokens");
  report("flushes", r.flushes, "renders");
  report("frames", r.frames, "frames");
  report("most flushes in one frame", r.maxPerFrame, "flushes");
  report("flushes outside a frame callback", r.outsideFrame, "flushes");
  return r;
}

interface FlushProbe {
  glPerf: { deltas: number; flushes: number; terminalFlush?: boolean };
  glFrames: number;
  glFlushFrames: number[];
  glOutsideFrame: number;
}

/**
 * The W-09 flush gate: a real stream of many tokens, never two flushes in one
 * frame, and every flush from a frame callback: the done event drops the
 * waiting words, it does not publish them.
 */
const oneFlushPerFrame = (r: { deltas: number; flushes: number; maxPerFrame: number; outsideFrame: number }) =>
  r.deltas > 50 && r.flushes > 0 && r.maxPerFrame <= 1 && r.outsideFrame === 0;

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

test("negative control: one extra flush at the terminal event fails the flush gate", async ({ page, open }) => {
  const r = await streamFlushes(page, open, true);
  expect(oneFlushPerFrame(r), JSON.stringify(r)).toBe(false);
});

/** Renders of the 6 seeded rows from "Writing" showing until well into the reply; bust turns the control on. */
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
  await expect(live.locator(".writing")).toBeVisible();
  const before = await page.evaluate(() => {
    const w = window as unknown as Probe;
    if (w.glRows) w.glRows.renders = {};
    return { flushes: w.glPerf?.flushes ?? 0, deltas: w.glPerf?.deltas ?? 0 };
  });
  // well into the reply (12 more tokens; the fake's reply is one paragraph, so
  // the live turn shows no text until it ends), and still streaming when the count is read
  await page.waitForFunction((d) => ((window as unknown as Probe).glPerf?.deltas ?? 0) >= d + 12, before.deltas);
  const renders = await page.evaluate((ids) => ids.reduce((a, id) => a + ((window as unknown as Probe).glRows?.renders[id] ?? 0), 0), seeded);
  await expect(live.locator(".writing")).toBeVisible();
  const flushes = (await page.evaluate(() => (window as unknown as Probe).glPerf?.flushes ?? 0)) - before.flushes;
  report(`seeded row renders while streaming${bust ? " (memo busted)" : ""}`, renders, "renders");
  report("flushes in the same window", flushes, "flushes");
  expect(flushes).toBeGreaterThan(5);
  await expect(page.locator(".writing")).toHaveCount(0, { timeout: 10_000 });
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
  await page.evaluate(endKeys, TYPED.length);
  const idle = keyStats(await page.evaluate(readKeys));
  reportKeys("idle", idle);
  await ta.fill("");

  // slow tokens so the stream outlasts the typing and the control after it
  reportLoad();
  await stack.scenario("models", { tokenDelayMs: 120 });
  // "Writing" shows from the first token until the reply ends, whether or not a whole block has shown yet
  const writing = page.locator(".writing");
  /** A reply streaming now: the one already running, else a new one. */
  const streaming = async () => {
    if (await writing.isVisible()) return;
    await sendMessage(page, "A slow reply please");
    await expect(writing).toBeVisible();
  };
  // one try: the burst typed while a reply streams; it counts only if the reply was still streaming at its end
  const streamTry = async () => {
    await streaming();
    await ta.fill("");
    await ta.focus();
    await page.evaluate(clearEvents);
    await typeFreely(page, TYPED);
    await expect(ta).toHaveValue(TYPED);
    await page.evaluate(endKeys, TYPED.length);
    const live = await writing.isVisible();
    return { ...keyStats(await page.evaluate(readKeys)), live };
  };
  const passes = (s: Awaited<ReturnType<typeof streamTry>>) => s.live && keysWithinBudget(s);
  const streams = [await streamTry()];
  while (streams.length < TRIES && !passes(streams[streams.length - 1]!)) streams.push(await streamTry());
  streams.forEach((s, i) => {
    reportKeys(`stream (try ${i + 1})`, s);
    if (!s.live) report(`stream (try ${i + 1}) ended before the burst did`, 1, "");
  });
  expect(streams.some(passes), JSON.stringify(streams)).toBe(true);
  for (const s of streams) expect(s.p95Processing, JSON.stringify(s)).toBeLessThanOrEqual(BUDGET.keyHandlerMs);

  // negative control: the main thread busy in back-to-back 100 ms tasks, so
  // each key waits for the task it lands in. The handlers stay as fast as
  // before; the gate must still fail. The slices chain through a
  // MessageChannel, so no timer clamp opens a gap between them, and the
  // channel hangs on window so nothing can collect it mid-burst. One try:
  // the control must fail the gate every time.
  await streaming();
  await ta.fill("");
  await ta.focus();
  await page.evaluate(clearEvents);
  await page.evaluate(() => {
    const w = window as unknown as { glBusy: boolean; glStamps: [number, number][]; glChan: MessageChannel };
    w.glBusy = true;
    w.glStamps = [];
    // each keydown's timestamp and the time its handlers ran
    window.addEventListener("keydown", (e) => w.glStamps.push([e.timeStamp, performance.now()]), { capture: true });
    const ch = new MessageChannel();
    w.glChan = ch;
    ch.port1.addEventListener("message", () => {
      if (!w.glBusy) return;
      const end = performance.now() + 100;
      while (performance.now() < end) {
        // spin
      }
      ch.port2.postMessage(null);
    });
    ch.port1.start();
    ch.port2.postMessage(null);
  });
  const BURST = "a shorter burst";
  await typeFreely(page, BURST);
  const stamps = await page.evaluate(() => {
    const w = window as unknown as { glBusy: boolean; glStamps: [number, number][] };
    w.glBusy = false;
    return w.glStamps;
  });
  await expect(ta).toHaveValue(BURST);
  await page.evaluate(endKeys, BURST.length);
  await expect(writing).toBeVisible();
  const raw = await page.evaluate(readKeys);
  const delayed = keyStats(raw);
  reportKeys("stream + 100 ms delay control", delayed);
  expect(keysWithinBudget(delayed), JSON.stringify(delayed)).toBe(false);
  expect(delayed.longestTask).toBeGreaterThanOrEqual(90);
  // Every key's wait behind a slice must show in its Event Timing duration
  // (8 ms rounding allowed). Event Timing leaves out events under 16 ms, so a
  // key may have no entry only if it waited 24 ms or less. In the runs where
  // every key is stamped after its slice, every wait is that short and the
  // long-task leg above fails the gate.
  expect(stamps, "one stamp per key").toHaveLength(BURST.length);
  report("stream + 100 ms delay control keys that waited over 24 ms", stamps.filter(([at, ran]) => ran - at > 24).length, "keys");
  for (const [at, ran] of stamps) {
    const wait = ran - at;
    const ev = raw.events.find((e) => e.name === "keydown" && Math.abs(e.start - at) < 1);
    const what = `keydown stamped at ${at.toFixed(1)}, handled ${wait.toFixed(1)} ms later`;
    if (ev === undefined) expect(wait, `${what}, no Event Timing entry`).toBeLessThanOrEqual(24);
    else expect(ev.duration, what).toBeGreaterThanOrEqual(wait - 8);
  }
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
