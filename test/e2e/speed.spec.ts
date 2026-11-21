/// <reference lib="dom" />
// Speed checks for the actions a person repeats all day, part of the release
// gate (test/e2e/journeys.txt). Each one does its action a few times and times
// it inside the page, from the input event that starts it to the first frame
// that shows the result, so Playwright's own round trips are not in the number.
// It prints the median as SPEED_MS {"action": ..., "ms": ...} and fails only
// past a wide limit, about three times the median measured on the test
// machines (2026-11-21) and never under 250 ms, so it catches a real regression
// and not a busy machine.
// The wall-clock timing journeys with no limit at all are the @timing tests in
// perf.spec.ts.
import type { Page } from "@playwright/test";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

/** Times each action is measured; the reading is their median. */
const ROUNDS = 5;

/** What the page must show: at least `min` (default 1) rendered elements matching `selector` whose trimmed text matches `text` (a case-insensitive regex source; any text when omitted). */
interface Shows { selector: string; text?: string; min?: number }

/** The input event that starts an action: the first `type` event, or the first with this `key`. */
interface Trigger { type: "pointerdown" | "keydown"; key?: string }

interface SpeedWindow extends Window { glSpeed?: Promise<number>; glOpened?: number }

const median = (runs: number[]): number => runs.toSorted((a, b) => a - b)[Math.floor(runs.length / 2)] ?? Number.NaN;

/** Print the median of `runs` as one SPEED_MS line, note every run on the test, and fail past `limitMs`. */
function check(action: string, runs: number[], limitMs: number): void {
  const ms = Math.round(median(runs));
  console.log(`SPEED_MS ${JSON.stringify({ action, ms })}`);
  test.info().annotations.push({ type: "measured", description: `${action}: median ${ms} ms of ${runs.map(Math.round).join(", ")}; limit ${limitMs} ms` });
  expect(ms, `${action}: median of ${runs.map(Math.round).join(", ")} ms`).toBeLessThan(limitMs);
}

/**
 * Milliseconds from the action's `trigger` event to the first animation frame
 * whose page `shows` everything asked. Fails if the page shows it already
 * before the action, or not within 10 s of the trigger.
 */
async function timed(page: Page, trigger: Trigger, shows: Shows[], act: () => Promise<void>): Promise<number> {
  await page.evaluate(({ on, wanted }) => {
    const shown = () => wanted.every(({ selector, text, min = 1 }) => {
      const pattern = text === undefined ? null : new RegExp(text, "i");
      let found = 0;
      for (const el of document.querySelectorAll(selector)) {
        if (el.getClientRects().length > 0 && (pattern === null || pattern.test(el.textContent?.trim() ?? ""))) found++;
      }
      return found >= min;
    });
    if (shown()) throw new Error(`shown before the action: ${JSON.stringify(wanted)}`);
    (window as SpeedWindow).glSpeed = new Promise<number>((resolve, reject) => {
      const start = (e: Event) => {
        if (on.key !== undefined && (e as KeyboardEvent).key !== on.key) return;
        removeEventListener(on.type, start, true);
        const from = performance.now();
        const limit = setTimeout(() => reject(new Error(`not shown 10 s after ${on.type}: ${JSON.stringify(wanted)}`)), 10_000);
        // performance.now(), not the frame's own timestamp: that is the frame's start, which can come before the event
        const frame = () => {
          if (!shown()) { requestAnimationFrame(frame); return; }
          clearTimeout(limit);
          resolve(performance.now() - from);
        };
        requestAnimationFrame(frame);
      };
      addEventListener(on.type, start, true);
    });
  }, { on: trigger, wanted: shows });
  await act();
  return page.evaluate(() => (window as SpeedWindow).glSpeed ?? Promise.reject(new Error("no measurement started")));
}

test("the app opens to a composer you can type in", async ({ page, open }) => {
  // from the navigation's start (the page's time origin) to the first frame with the app's data and an open composer
  await page.addInitScript(() => {
    const frame = (now: number) => {
      if (document.querySelector("#app[data-ready]") !== null && document.querySelector(".composer:not(.blocked)") !== null && document.querySelector("#ta:enabled") !== null) (window as SpeedWindow).glOpened = now;
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  await open();
  await waitReady(page);
  const runs: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    await page.reload();
    const opened = await page.waitForFunction(() => (window as SpeedWindow).glOpened);
    runs.push(Number(await opened.jsonValue()));
  }
  check("open app", runs, 250); // median 82 ms
});

test("the first words of a reply after Send", async ({ page, open }) => {
  await open();
  await waitReady(page);
  // the fake answers at once, so the time is the app's: the send, the server, the stream and the render
  await stack.scenario("models", { firstTokenDelayMs: 0, tokenDelayMs: 0 });
  const replies = page.locator(".turn.a");
  // one untimed turn first: it loads the model, which a person does once, not all day
  await sendMessage(page, "Warm up");
  await expect(replies.last()).toHaveClass(/\bdone\b/, { timeout: 15_000 });
  const runs: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const before = await replies.count();
    await page.locator("#ta").fill(`Round ${i + 1}`);
    runs.push(await timed(page, { type: "keydown", key: "Enter" }, [{ selector: ".turn.a .md", text: "\\S", min: before + 1 }], () => page.locator("#ta").press("Enter")));
    await expect(replies.last()).toHaveClass(/\bdone\b/, { timeout: 15_000 });
  }
  check("first words after Send", runs, 350); // median 112 ms
});

test("opening Settings", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const settings = page.getByRole("dialog", { name: "Settings" });
  const runs: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    runs.push(await timed(page, { type: "keydown", key: "," }, [{ selector: ".set .set-h h1", text: "\\S" }], () => page.keyboard.press("Control+Comma")));
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
  }
  check("open Settings", runs, 250); // median 12 ms
});

test.describe("with the design's threads", () => {
  test.use({ seed: "design" });

  test("switching between two threads", async ({ page, open, seededThread }) => {
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    const threads = [
      { title: "Fix the backup cron", first: "^Fix the backup cron$" },
      { title: "Library: Effect Schema books", first: "^Which Effect Schema books" },
    ];
    const switchTo = (thread: { title: string; first: string }) => timed(page, { type: "pointerdown" }, [
      { selector: ".hdr h2", text: `^${thread.title}$` },
      { selector: ".turn.u .bubble", text: thread.first },
    ], () => page.locator(".sb-row").filter({ hasText: thread.title }).click());
    // both threads opened once untimed: the all-day switch is between threads this window has open
    await expect(page.locator(".turn.u .bubble").first()).toHaveText(/^Which Effect Schema books/);
    await switchTo(threads[0]!);
    await switchTo(threads[1]!);
    const runs: number[] = [];
    for (let i = 0; i < ROUNDS; i++) runs.push(await switchTo(threads[i % 2]!));
    check("switch thread", runs, 250); // median 0 ms before the frame-start fix
  });
});
