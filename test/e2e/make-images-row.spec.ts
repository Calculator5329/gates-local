// Settings › Tools on a touch screen: the Make images row holds its height when "Let the model use
// tools" flips (its reason's two sentences share one cell, and on touch a link is 44 px tall), and
// the link in the hidden sentence is never reached by Tab.
import type { Locator, Page } from "@playwright/test";
import { expect, test, waitReady } from "./fixtures.ts";

test.use({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, video: "off" });

/** What Tab reaches, in order, from the master switch: each stop's data-go or its name. */
const tabStops = async (page: Page, from: Locator, count: number) => {
  await from.focus();
  const stops: string[] = [];
  for (let i = 0; i < count; i += 1) {
    await page.keyboard.press("Tab");
    stops.push(await page.evaluate(() => {
      const e = document.activeElement;
      return e?.getAttribute("data-go") ?? e?.getAttribute("aria-label") ?? e?.textContent?.trim().slice(0, 24) ?? "";
    }));
  }
  return stops;
};

test("on touch the Make images row keeps its height when the switch above flips, and the hidden link takes no focus", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await page.keyboard.press("Control+Comma");
  await page.getByRole("button", { name: "Back to Settings" }).click();
  await page.locator(".set-list").getByRole("button", { name: "Tools" }).click();
  await expect(page.locator(".set h1").first()).toHaveText("Tools");
  const row = page.locator('.set .srow[data-tool="images"]');
  const master = page.getByRole("switch", { name: "Let the model use tools" });
  await expect(master).toHaveAttribute("aria-checked", "true");
  await expect(row).toContainText("Needs Generate images, in Image generation.");
  const height = () => row.evaluate((e) => Math.round(e.getBoundingClientRect().height * 10) / 10);
  const lines = () => row.locator(".steady").evaluate((e) => Math.round(e.getBoundingClientRect().height * 10) / 10);
  const on = { row: await height(), reason: await lines() };
  expect(await tabStops(page, master, 6), "the link is a stop while its sentence shows").toContain("images");

  await master.click();
  await expect(master).toHaveAttribute("aria-checked", "false");
  await expect(row).toContainText("Needs the switch above.");
  expect({ row: await height(), reason: await lines() }, "the row and its reason cell, with the switch above off").toEqual(on);
  expect(await tabStops(page, master, 6), "the hidden sentence's link takes no focus").not.toContain("images");

  await master.click();
  await expect(master).toHaveAttribute("aria-checked", "true");
  expect(await height(), "on again").toBe(on.row);
});
