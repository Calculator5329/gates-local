/// <reference lib="dom" />
// What a browser test waits for when no locator, count or message says it: the page having
// drawn what it laid out, the page come to rest, or a claim that nothing happens over a span.
// `holds` is the only place a test may wait on the clock (lint `gates/no-wait-for-timeout`).
// No fixtures are imported here, so the perf and bug finder suites can use it too.
import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Resolves once the browser has drawn two frames from now. Resize observers and the scroll
 * they set run before a frame is drawn, so a box read after this is the one on screen.
 */
export async function painted(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

/** Transitions and animations still running under `el` that have an end; runs in the page. */
const easing = (el: Element) => el.getAnimations({ subtree: true })
  .filter((a) => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming().endTime ?? Number.POSITIVE_INFINITY)).length;

/**
 * Resolves once the fonts are in and no transition or animation that ends is running in
 * `root` (the whole page when left out), then a frame is drawn: where things came to rest.
 * Endless ones (a spinner, a pulsing dot) are left out, since they never rest.
 */
export async function settled(page: Page, root?: Locator): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect.poll(() => (root ?? page.locator(":root")).evaluate(easing), { message: "something on the page is still easing" }).toBe(0);
  await painted(page);
}

/**
 * The one wait on the clock: a claim that nothing happens for `ms` ("past the tooltip's delay,
 * no tooltip"). `read` is sampled about every `every` ms through the whole span and must equal
 * `expected` each time, so a thing that shows and goes again inside the span fails it, not only
 * one still there at the end. `read` answers at once: no retrying assertion inside it.
 */
export async function holds<T>(page: Page, ms: number, read: () => Promise<T>, expected: T, options: { message?: string; every?: number } = {}): Promise<void> {
  const every = options.every ?? 50;
  const start = Date.now();
  for (;;) {
    const at = Date.now() - start;
    const seen: unknown = await read();
    expect(seen, `${options.message ?? "the claim"}, at ${at} of ${ms} ms`).toEqual(expected);
    const left = ms - (Date.now() - start);
    if (left <= 0) return;
    await page.waitForTimeout(Math.min(every, left));
  }
}
