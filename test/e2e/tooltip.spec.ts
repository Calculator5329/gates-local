/// <reference lib="dom" />
// Tooltips wait for the pointer to rest, do not fire as it passes, and never
// draw over an open menu from something behind it. Times are taken in the page,
// so a slow machine cannot move them.
import type { Page } from "@playwright/test";
import { expect, test, waitReady } from "./fixtures.ts";

test.use({ video: "on" });

interface Rec {
  start: number | null;
  opened: number | null;
}
type Watched = Window & { glTip?: Rec };

/** Record when `selector` was reached (pointer or focus) and when #tip next showed something. */
async function watchTip(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const tip = document.querySelector("#tip");
    if (!el || !tip) throw new Error(`no ${sel} or no #tip`);
    const rec: Rec = { start: null, opened: null };
    (window as Watched).glTip = rec;
    const reached = () => {
      rec.start ??= performance.now();
    };
    el.addEventListener("mouseover", reached, true);
    el.addEventListener("focusin", reached, true);
    // new content means a tooltip was shown, even one closed again in the same task
    new MutationObserver((records) => {
      if (records.some((m) => m.type === "childList")) rec.opened ??= performance.now();
    }).observe(tip, { childList: true });
  }, selector);
}

const rec = (page: Page) =>
  page.evaluate(() => {
    const r = (window as Watched).glTip;
    if (!r) throw new Error("not watching");
    return r;
  });

/** Longer than any tooltip delay: what has not opened by now was not going to. */
const settle = (page: Page) => page.waitForTimeout(800);

test.describe("tooltips", () => {
  test.use({ seed: "design" });

  test.beforeEach(async ({ page, open, seededThread }) => {
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    await page.locator("#ta").hover();
  });

  test("a tooltip waits for the pointer to rest", async ({ page }) => {
    await watchTip(page, "#plusBtn");
    await page.locator("#plusBtn").hover();
    await expect(page.locator("#tip.open")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("tooltip.png") });
    const r = await rec(page);
    expect((r.opened ?? 0) - (r.start ?? 0)).toBeGreaterThanOrEqual(300);
  });

  test("a pointer passing over a control shows nothing", async ({ page }) => {
    await watchTip(page, "#plusBtn");
    // in one task, so the pass takes no time however busy the machine is
    await page.evaluate(() => {
      document.querySelector("#plusBtn")?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      document.querySelector("#ta")?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    await settle(page);
    expect((await rec(page)).opened).toBeNull();
  });

  test("moving on from an open tooltip shows the next one at once", async ({ page }) => {
    await page.locator("#plusBtn").hover();
    await expect(page.locator("#tip.open")).toBeVisible();
    await watchTip(page, "#modelBtn");
    await page.locator("#modelBtn").hover();
    await expect.poll(async () => (await rec(page)).opened).not.toBeNull();
    const r = await rec(page);
    expect((r.opened ?? 0) - (r.start ?? 0)).toBeLessThan(200);
  });

  test("keyboard focus shows a tooltip at once", async ({ page }) => {
    await page.locator("#ta").focus();
    await watchTip(page, "#plusBtn");
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      if (await page.locator("#plusBtn").evaluate((el) => el === document.activeElement)) break;
    }
    await expect(page.locator("#plusBtn")).toBeFocused();
    await expect.poll(async () => (await rec(page)).opened).not.toBeNull();
    const r = await rec(page);
    expect((r.opened ?? 0) - (r.start ?? 0)).toBeLessThan(200);
  });

  test("a mouse click does not bring the tooltip back", async ({ page }) => {
    // Copy leaves the tooltip alone when clicked; controls that act on the chat close it themselves
    const copy = page.getByRole("button", { name: "Copy", exact: true }).first();
    await copy.hover();
    await expect(page.locator("#tip.open")).toBeVisible();
    await copy.click();
    await settle(page);
    await expect(page.locator("#tip.open")).toHaveCount(0);
  });

  test("nothing behind an open popover draws a tooltip over it", async ({ page }) => {
    await page.locator("#modelBtn").click();
    await expect(page.locator("#picker")).toBeVisible();
    await watchTip(page, "#plusBtn");
    await page.locator("#plusBtn").hover();
    await settle(page);
    expect((await rec(page)).opened).toBeNull();
  });

  test("a row inside the open picker still has its tooltip", async ({ page }) => {
    await page.locator("#modelBtn").click();
    await page.locator("#picker .pk-r").first().hover();
    await expect(page.locator("#tip.open")).toBeVisible();
  });
});
