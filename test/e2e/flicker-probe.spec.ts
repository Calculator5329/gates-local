/// <reference lib="dom" />
// The probe's own checks, on a plain page: what it reports as moved.
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { TRACK, type WholeFrame, wholeFindings, wholeSampler } from "./flicker-probe.ts";

const PAGE = `<main id="r" aria-busy="true">
  <div class="sb-skel" data-skel="" aria-hidden="true" style="position:absolute;left:8px;top:92px;width:239px;height:300px"></div>
  <span class="skel" data-skel="" aria-hidden="true" style="position:absolute;left:600px;top:400px;width:119px;height:21px"></span>
</main>`;

async function watch(page: Page, change: () => void): Promise<WholeFrame[]> {
  await page.goto("about:blank");
  await page.setContent(PAGE);
  await page.evaluate(wholeSampler, { root: "#r", track: TRACK });
  await page.waitForFunction(() => (window as unknown as { wholeWatch: { frames: unknown[] } }).wholeWatch.frames.length > 5);
  await page.evaluate(change);
  const before = await page.evaluate(() => (window as unknown as { wholeWatch: { frames: unknown[] } }).wholeWatch.frames.length);
  await page.waitForFunction((n) => (window as unknown as { wholeWatch: { frames: unknown[] } }).wholeWatch.frames.length > n + 5, before);
  return page.evaluate(() => {
    const w = window as unknown as { wholeWatch: { frames: WholeFrame[]; on: boolean } };
    w.wholeWatch.on = false;
    return w.wholeWatch.frames;
  });
}

test("a placeholder that goes is not read as another one that moved", async ({ page }) => {
  const frames = await watch(page, () => document.querySelector(".sb-skel")?.remove());
  expect(wholeFindings("start", frames).filter((f) => f.kind === "moved")).toEqual([]);
});

test("a placeholder that moves is still reported", async ({ page }) => {
  const frames = await watch(page, () => { (document.querySelector(".sb-skel") as HTMLElement).style.left = "400px"; });
  expect(wholeFindings("start", frames).filter((f) => f.kind === "moved")).toHaveLength(1);
});
