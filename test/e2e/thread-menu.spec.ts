/// <reference lib="dom" />
// Thread actions live on the sidebar row, with a reserved slot so revealing
// the menu button cannot resize the title, timestamp, or row.
import type { Locator, Page } from "@playwright/test";
import { expect, test, waitReady } from "./fixtures.ts";

test.use({ seed: "design" });

const OPEN = "Library: Effect Schema books";
const OTHER = "Fix the backup cron";
const MENU = ["Rename", "Export as Markdown", "Delete thread"];
const row = (page: Page) => page.locator(".sb-row").filter({ hasText: OTHER });
const actions = (page: Page) => row(page).getByRole("button", { name: `Thread actions: ${OTHER}`, exact: true, includeHidden: true });
const menu = (page: Page) => page.getByRole("menu", { name: "Thread actions", exact: true });

/** Both visibility and opacity count: an invisible button must not paint before hover. */
const painted = (el: Locator) =>
  el.evaluate((node) => {
    const s = getComputedStyle(node);
    return node.getClientRects().length > 0 && s.display !== "none" && s.visibility === "visible" && Number(s.opacity) > 0;
  });

async function boxes(page: Page) {
  const target = row(page);
  const result = {
    row: await target.boundingBox(),
    title: await target.locator(".t").boundingBox(),
    age: await target.locator(".ago").boundingBox(),
  };
  for (const box of Object.values(result)) expect(box).not.toBeNull();
  return result;
}

// Guards the owner's ruling on the thread menu: a ⋯ on the row's hover that moves nothing and keeps the open thread.
test("hover reveals a row menu without moving its row, title, or age, and clicking it keeps the open thread", async ({ page, open, seededThread }) => {
  await open(`#thread=${seededThread ?? ""}`);
  await waitReady(page);
  await page.locator("#ta").hover();
  const before = await boxes(page);
  const url = page.url();
  const button = actions(page);
  await expect(button).toHaveCount(1);
  expect(await painted(button), "no row hover or focus yet").toBe(false);

  await row(page).locator(".t").hover();
  await expect.poll(() => painted(button)).toBe(true);
  expect(await boxes(page), "revealing the button reserves exactly the same space").toEqual(before);
  await button.click();
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole("menuitem")).toHaveText(MENU);
  await expect(page.locator(".hdr h2")).toHaveText(OPEN);
  expect(page.url(), "the menu click does not select its thread").toBe(url);
  await expect(page.locator("#moreBtn, #moreMenu, .hdr [aria-haspopup=menu]")).toHaveCount(0);

  await page.locator("#ta").hover();
  expect(await painted(button), "the open menu keeps its own button visible").toBe(true);
  expect(await boxes(page), "moving off the open menu's row leaves its contents still").toEqual(before);
});
