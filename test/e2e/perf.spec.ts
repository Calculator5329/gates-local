/// <reference lib="dom" />
// Performance on the production build. The @timing tests measure and log
// wall-clock numbers (first paint, ready composer, key event to paint,
// longest task) and assert none of them: a fixed millisecond line is true on
// the machine it was measured on and nowhere else, and the lines set on
// 2026-11-07 were missed at 0.2.0, 0.2.1 and 0.2.2 on the test machine without
// holding a release. Whether a release got slower is judged by the paired
// comparison against the last release on the same machine in the same run
// (test/perf/compare.ts). What these tests still assert does not depend on
// the machine: the measurement happened, the key handlers stay cheap, and
// each observer sees a delay it is given. Sizes are informational soft
// targets. Functional checks and unmeasurable bundles still block releases.
import { cpus, loadavg } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { ROOT, appUrl } from "./env.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";
import { bundleSizeWarnings, bundleSize } from "../bundle-size.ts";

// p95 handler time per keydown/input event while streaming: the app's own
// work per key, one 60 Hz frame. Measured 0.6 ms; it holds on a busy machine.
const KEY_HANDLER_MS = 16;

/** Tries for the typing burst: a try counts only if the reply was still streaming when the burst ended. */
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

/** The same controlled busy main thread for the functional journey and the timing measurement. */
function beginBusyTyping() {
  const w = window as unknown as { glBusy: boolean; glStamps: [number, number][]; glChan: MessageChannel };
  w.glBusy = true;
  w.glStamps = [];
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
}

async function busyBurst(page: Page, text: string) {
  const ta = page.locator("#ta");
  await ta.fill("");
  await ta.focus();
  await page.evaluate(clearEvents);
  await page.evaluate(beginBusyTyping);
  let stamps: [number, number][];
  try { await typeFreely(page, text); }
  finally {
    stamps = await page.evaluate(() => {
      const w = window as unknown as { glBusy: boolean; glStamps: [number, number][] };
      w.glBusy = false;
      return w.glStamps;
    });
  }
  const value = await ta.inputValue();
  return { stamps, value };
}

test.beforeEach(async ({ page }) => {
  if (test.info().tags.includes("@timing")) test.info().annotations.push({ type: "budget", description:
    `measured, not asserted: first paint, ready composer, longest task, key p95; asserted: key processing <=${KEY_HANDLER_MS} ms` });
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

// Guards the owner's ask that the app opens fast and clean; the release check names this title.
test("cold load reaches a ready composer without console errors", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" });
  try {
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    await page.addInitScript(() => localStorage.setItem("gates-local.first-run-done", "1"));
    await page.goto(appUrl());
    await waitReady(page);
    expect(errors, "console errors").toEqual([]);
  } finally { await ctx.close(); }
});

// Guards the owner's ask that the app opens fast: cold load timing.
test("cold load: first paint and time to a ready composer", { tag: "@timing" }, async ({ page, open }) => {
  reportLoad();
  await open();
  const cold = await coldTimes(page);
  report("first contentful paint", cold.fcp, "ms");
  report("ready composer", cold.ready, "ms");
  expect(Number.isFinite(cold.fcp) && cold.fcp > 0, JSON.stringify(cold)).toBe(true);
  expect(cold.ready).toBeGreaterThanOrEqual(cold.fcp);
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

// Guards the owner's ask for a steady, paced reveal: one store flush per frame at most.
test("streaming flushes at most once in any frame", async ({ page, open }) => {
  const r = await streamFlushes(page, open);
  expect(r.flushes).toBeLessThan(r.deltas);
  expect(oneFlushPerFrame(r), JSON.stringify(r)).toBe(true);
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

  // Guards the owner's ask that a long conversation stays fast: finished turns do not re-render while a reply streams.
  test("do not re-render", async ({ page, open, seededThread }) => {
    expect(await seededRenders(page, open, seededThread, false)).toBe(0);
  });
});

// Guards the owner's ask that a long conversation opens and scrolls fast; the release check names the first title.
test.describe("a 400-message thread", () => {
  test.use({ seed: 400 });
  // chat row 40: the page holds a window of the latest 200 and loads the rest when asked
  test("renders the latest 200 messages, and all 400 after Load earlier", async ({ page, open, seededThread }) => {
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    await expect(page.locator(".tl .turn")).toHaveCount(200);
    await page.getByTestId("chat.thread.earlier").click();
    await expect(page.locator(".tl .turn")).toHaveCount(400);
    await expect(page.getByTestId("chat.thread.earlier")).toHaveCount(0);
  });
  // Guards the owner's ask that a long conversation scrolls smoothly.
  test("opens and scrolls: the longest task is measured", { tag: "@timing" }, async ({ page, open, seededThread }) => {
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
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

    // the observer must see a task it should: a 70 ms spin shows up
    await page.evaluate(busy, 70);
    await expect.poll(() => page.evaluate(() => Math.max(0, ...(window as unknown as { glLong: number[] }).glLong))).toBeGreaterThanOrEqual(60);
  });
});

// Guards the owner's ask that typing never drops a key, idle or while a reply streams; the release check names it.
test("typing preserves every character while idle, streaming and busy", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const ta = page.locator("#ta");
  const typed = "typing while the reply streams in";
  await ta.focus();
  await typeFreely(page, typed);
  await expect(ta).toHaveValue(typed);
  await ta.fill("");
  // Keep the fake reply active throughout this functional journey; no speed budget is asserted here.
  await stack.scenario("models", { tokenDelayMs: 120, replyWords: 180 });
  await sendMessage(page, "A slow reply please");
  const writing = page.locator(".writing");
  await expect(writing).toBeVisible();
  await ta.focus();
  await typeFreely(page, typed);
  await expect(ta).toHaveValue(typed);
  await expect(writing).toBeVisible();
  const burst = "a shorter burst";
  const delayed = await busyBurst(page, burst);
  expect(delayed.value).toBe(burst);
  expect(delayed.stamps, "one stamp per key").toHaveLength(burst.length);
  await expect(writing).toBeVisible();
});

// Guards the owner's ask that typing stays fast while a reply streams.
test("typing during a stream: p95 key event, input to paint", { tag: "@timing" }, async ({ page, open }) => {
  await open();
  await waitReady(page);
  const ta = page.locator("#ta");
  const TYPED = "typing while the reply streams in";

  // idle baseline: the same typing with nothing streaming
  await ta.focus();
  await page.evaluate(clearEvents);
  await typeFreely(page, TYPED);
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
    await page.evaluate(endKeys, TYPED.length);
    const live = await writing.isVisible();
    return { ...keyStats(await page.evaluate(readKeys)), live };
  };
  const passes = (s: Awaited<ReturnType<typeof streamTry>>) => s.live && s.dispatched >= 20;
  const streams = [await streamTry()];
  while (streams.length < TRIES && !passes(streams[streams.length - 1]!)) streams.push(await streamTry());
  streams.forEach((s, i) => {
    reportKeys(`stream (try ${i + 1})`, s);
    if (!s.live) report(`stream (try ${i + 1}) ended before the burst did`, 1, "");
  });
  expect(streams.some(passes), JSON.stringify(streams)).toBe(true);
  for (const s of streams) expect(s.p95Processing, JSON.stringify(s)).toBeLessThanOrEqual(KEY_HANDLER_MS);

  // negative control: the main thread busy in back-to-back 100 ms tasks, so
  // each key waits for the task it lands in. The handlers stay as fast as
  // before; the measurement must show the wait. The slices chain through a
  // MessageChannel, so no timer clamp opens a gap between them, and the
  // channel hangs on window so nothing can collect it mid-burst. One try.
  await streaming();
  const BURST = "a shorter burst";
  const { stamps } = await busyBurst(page, BURST);
  await page.evaluate(endKeys, BURST.length);
  const raw = await page.evaluate(readKeys);
  const delayed = keyStats(raw);
  reportKeys("stream + 100 ms delay control", delayed);
  expect(delayed.longestTask, JSON.stringify(delayed)).toBeGreaterThanOrEqual(90);
  // Every key's wait behind a slice must show in its Event Timing duration
  // (8 ms rounding allowed). Event Timing leaves out events under 16 ms, so a
  // key may have no entry only if it waited 24 ms or less. In the runs where
  // every key is stamped after its slice, every wait is that short and the
  // long-task leg above shows the busy main thread.
  report("stream + 100 ms delay control keys that waited over 24 ms", stamps.filter(([at, ran]) => ran - at > 24).length, "keys");
  for (const [at, ran] of stamps) {
    const wait = ran - at;
    const ev = raw.events.find((e) => e.name === "keydown" && Math.abs(e.start - at) < 1);
    const what = `keydown stamped at ${at.toFixed(1)}, handled ${wait.toFixed(1)} ms later`;
    if (ev === undefined) expect(wait, `${what}, no Event Timing entry`).toBeLessThanOrEqual(24);
    else expect(ev.duration, what).toBeGreaterThanOrEqual(wait - 8);
  }
});

// Guards the owner's ruling that bundle limits are soft: report the size, warn past the limit.
test("bundle size", () => {
  const size = bundleSize(path.join(ROOT, "apps/web/dist"));
  report("entry JS gzip", size.entryJs, "KiB");
  report("total JS gzip", size.totalJs, "KiB");
  report("startup CSS gzip", size.startupCss, "KiB");
  report("total CSS gzip", size.totalCss, "KiB");
  for (const warning of bundleSizeWarnings(size)) {
    test.info().annotations.push({ type: "measured", description: `Bundle warning: ${warning}` });
    process.stdout.write(`[perf] bundle warning: ${warning}\n`);
  }
});
