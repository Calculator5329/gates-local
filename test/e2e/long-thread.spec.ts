/// <reference lib="dom" />
// One journey through a 2,000-message thread: it opens at its end with a
// bounded first commit, scrolling to the top mounts a slice at once, the turn
// the reader is looking at stays put while idle slices mount everything above
// it, and the whole thread ends up in the page. A probe in the page samples
// after each slice and in the frame after it, and asks for no other frames,
// so the backfill runs at the browser's own pace.
import { expect, test, waitReady } from "./fixtures.ts";

const TURNS = 2000;
test.use({ seed: TURNS });

/** Thread.tsx FIRST_TURNS, SLICE_TURNS and FILL_TURNS. */
const FIRST = 40;
const SLICE = 40;
const FILL = 120;

interface LongProbe {
  /** Turns in the first commit that mounted any. */
  first: number;
  /** Milliseconds from navigation to the first turns, and to every turn mounted. */
  firstAt: number;
  fullAt: number;
  /** Idle callbacks the app's backfill has run. */
  idleRuns: number;
  /** The scroll to the top: turns and idle runs just before and just after the app handled it. */
  scroll: { turns: number; idleRuns: number; turnsAfter: number; idleRunsAfter: number; moved: number } | null;
  /** Largest distance the turn in view moved from its place, sampled after each slice and in the frame after it. */
  drift: number;
  samples: number;
  /** Times the turn count grew after the scroll: the idle slices that mounted the rest. */
  steps: number;
}

declare global {
  interface Window { longProbe?: LongProbe }
}

// Guards the owner's ask that long conversations open fast, at their end, and hold still.
test("a 2,000-message thread opens at its end, keeps the turn in view still, and mounts in full", async ({ page, open, seededThread }) => {
  // Seeding 2,000 messages alone takes 3 to 17 s on the test machine, depending on its load; the
  // journey checks counts and positions, never speed.
  test.setTimeout(90_000);
  await page.addInitScript(({ total, timeline }) => {
    const probe: LongProbe = { first: 0, firstAt: 0, fullAt: 0, idleRuns: 0, scroll: null, drift: 0, samples: 0, steps: 0 };
    window.longProbe = probe;
    // Idle callbacks wait until the scroll below has been handled, so no slice can land between the
    // scroll and the app's handler; after that they go to the browser, which runs them at its pace.
    const idle = window.requestIdleCallback.bind(window);
    const cancelIdle = window.cancelIdleCallback.bind(window);
    const waiting = new Map<number, [IdleRequestCallback, IdleRequestOptions | undefined]>();
    let holding = true, nextHeld = 0;
    const counted = (fn: IdleRequestCallback): IdleRequestCallback => (deadline) => { probe.idleRuns++; fn(deadline); };
    window.requestIdleCallback = (fn, options) => {
      if (!holding) return idle(counted(fn), options);
      waiting.set(--nextHeld, [fn, options]);
      return nextHeld;
    };
    window.cancelIdleCallback = (id) => { if (!waiting.delete(id)) cancelIdle(id); };
    const letGo = () => {
      holding = false;
      for (const [fn, options] of waiting.values()) idle(counted(fn), options);
      waiting.clear();
    };
    const count = () => document.querySelectorAll(`${timeline} .turn`).length;
    /** Distance from the top of the timeline's view. */
    const offset = (el: Element) => el.getBoundingClientRect().top - (document.querySelector(timeline)?.getBoundingClientRect().top ?? 0);
    // The turn the reader looks at once scrolled up, and where it sat then.
    let watched: { readonly el: Element; readonly at: number } | null = null;
    let framePending = false;
    const sample = () => {
      if (watched === null) return;
      probe.samples++;
      probe.drift = Math.max(probe.drift, Math.abs(offset(watched.el) - watched.at));
    };
    // After the first commit (the app's scroll listener is attached by then), scroll to the top from
    // a task, as a key or a wheel would: a scroll set inside a frame callback lands after that frame's
    // resize observers, which still see the view stuck to the end and put it back.
    const scrollUp = () => {
      const tl = document.querySelector(timeline);
      const oldest = tl?.querySelector(".turn");
      if (tl == null || oldest == null) throw new Error("no timeline");
      // where the oldest mounted turn sits once scrolled to the top: nothing above it moves
      const expected = offset(oldest) + tl.scrollTop;
      let turns = 0, idleRuns = 0;
      // capture runs before the app's listener on the timeline, the listener below after it
      window.addEventListener("scroll", () => { turns = count(); idleRuns = probe.idleRuns; }, { capture: true, once: true });
      tl.addEventListener("scroll", () => {
        if (probe.scroll !== null) return;
        probe.scroll = { turns, idleRuns, turnsAfter: count(), idleRunsAfter: probe.idleRuns, moved: offset(oldest) - expected };
        letGo();
        // from here the reader looks at that turn while the rest mounts above it
        watched = { el: oldest, at: offset(oldest) };
      });
      tl.scrollTop = 0;
    };
    let seen = 0;
    const watch = new MutationObserver(() => {
      const n = count();
      if (n === 0) return;
      if (watched !== null && n > seen) probe.steps++;
      seen = n;
      if (probe.first === 0) {
        probe.first = n;
        probe.firstAt = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(scrollUp)));
      }
      // each slice is committed and corrected by now; the frame after it shows any resize it caused
      sample();
      if (watched !== null && !framePending) {
        framePending = true;
        requestAnimationFrame(() => { framePending = false; sample(); });
      }
      if (n === total) {
        probe.fullAt = performance.now();
        watch.disconnect();
      }
    });
    watch.observe(document, { childList: true, subtree: true });
  }, { total: TURNS, timeline: ".tl" });

  await open(`#thread=${seededThread ?? ""}`);
  await waitReady(page);
  const turns = page.locator(".tl .turn");
  await expect(turns).toHaveCount(TURNS, { timeout: 45_000 });
  await expect.poll(() => page.evaluate(() => window.longProbe?.fullAt ?? 0), { message: "the probe saw every turn mount" }).toBeGreaterThan(0);
  const probe = await page.evaluate(() => window.longProbe);
  if (probe === undefined || probe.scroll === null) throw new Error(`the probe did not see the scroll: ${JSON.stringify(probe)}`);
  console.info(`LONG_THREAD ${JSON.stringify({ firstCommitTurns: probe.first, firstTurnsMs: Math.round(probe.firstAt), fullyMountedMs: Math.round(probe.fullAt), idleRuns: probe.idleRuns, samples: probe.samples, steps: probe.steps, driftPx: probe.drift, scroll: probe.scroll })}`);

  expect(probe.first, "turns in the first commit").toBeGreaterThan(0);
  expect(probe.first, "turns in the first commit").toBeLessThanOrEqual(FIRST);
  expect(probe.scroll.idleRunsAfter, "no idle slice ran during the scroll").toBe(probe.scroll.idleRuns);
  expect(probe.scroll.turnsAfter, "scrolling to the top mounted one slice at once").toBe(probe.scroll.turns + SLICE);
  expect(Math.abs(probe.scroll.moved), "the turn at the top stayed there").toBeLessThanOrEqual(1);
  expect(probe.samples, "slices watched during the backfill").toBeGreaterThan(0);
  expect(probe.drift, "the turn in view moved while older turns mounted").toBeLessThanOrEqual(1);
  // each slice renders every mounted row and lays out the column again, so the rest goes in few large slices
  expect(probe.steps, "idle slices that mounted the rest").toBeLessThanOrEqual(Math.ceil((TURNS - FIRST - SLICE) / FILL));
  await expect(turns.first()).toContainText("Question 1:");
  await expect(turns.last()).toHaveAttribute("aria-label", /reply/i);
});
