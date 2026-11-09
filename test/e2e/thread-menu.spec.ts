/// <reference lib="dom" />
// Thread actions live on the sidebar row, with a reserved slot so revealing
// the menu button cannot resize the title, timestamp, or row.
import type { Locator, Page } from "@playwright/test";
import { expect, test, waitReady } from "./fixtures.ts";

test.use({ seed: "design", video: "on" });

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

async function openThread(page: Page, open: (hash?: string) => Promise<void>, id: string | null): Promise<void> {
  await open(`#thread=${id ?? ""}`);
  await waitReady(page);
  await page.locator("#ta").hover();
}

test("hover reveals a row menu without moving its row, title, or age, and clicking it keeps the open thread", async ({ page, open, seededThread }) => {
  await openThread(page, open, seededThread);
  const before = await boxes(page);
  const url = page.url();
  const button = actions(page);
  await expect(button).toHaveCount(1);
  expect(await painted(button), "no row hover or focus yet").toBe(false);
  await expect(button).toHaveAttribute("aria-haspopup", "menu");
  await expect(button).toHaveAttribute("aria-expanded", "false");

  await row(page).locator(".t").hover();
  await expect.poll(() => painted(button)).toBe(true);
  expect(await boxes(page), "revealing the button reserves exactly the same space").toEqual(before);
  await button.hover();
  await expect(page.locator("#tip.open")).toContainText("Thread actions");
  await button.click();
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole("menuitem")).toHaveText(MENU);
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".hdr h2")).toHaveText(OPEN);
  expect(page.url(), "the menu click does not select its thread").toBe(url);
  await expect(page.locator("#moreBtn, #moreMenu, .hdr [aria-haspopup=menu]")).toHaveCount(0);

  await menu(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const [anchor, popup] = [await button.boundingBox(), await menu(page).boundingBox()];
  expect(anchor).not.toBeNull();
  expect(popup).not.toBeNull();
  expect(Math.abs((popup?.y ?? 0) - ((anchor?.y ?? 0) + (anchor?.height ?? 0) + 6)), "menu below its button").toBeLessThan(2);

  await page.locator("#ta").hover();
  expect(await painted(button), "the open menu keeps its own button visible").toBe(true);
  expect(await boxes(page), "moving off the open menu's row leaves its contents still").toEqual(before);
  await page.screenshot({ path: test.info().outputPath("thread-menu.png") });
});

test("keyboard focus reveals the row button and Tab reaches it; Escape restores its focus", async ({ page, open, seededThread }) => {
  await openThread(page, open, seededThread);
  const button = actions(page);
  await expect(button).toHaveCount(1);
  await row(page).locator(".t").evaluate((el) => {
    const thread = el.closest("button,a[href],[tabindex]");
    if (!(thread instanceof HTMLElement)) throw new Error("the thread title has no focusable control");
    thread.focus();
  });
  expect(await row(page).evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await expect(button).not.toBeFocused();
  expect(await painted(button), "focus within the row reveals its actions").toBe(true);
  await page.keyboard.press("Tab");
  await expect(button).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu(page).getByRole("menuitem", { name: "Rename", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu(page).getByRole("menuitem", { name: "Export as Markdown", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute("aria-expanded", "false");
});

test.describe("touch thread actions", () => {
  test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

  test("every action is reachable from an always-visible drawer-row button", async ({ page, open, seededThread }) => {
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    await expect(page.locator(".hdr [aria-haspopup=menu]")).toHaveCount(0);
    await page.getByRole("button", { name: "Open threads" }).tap();
    await expect(row(page)).toBeInViewport({ ratio: 1 });
    const button = actions(page);
    await expect(button).toHaveCount(1);
    expect(await painted(button), "touch has no hover to reveal this button").toBe(true);
    const box = await button.boundingBox();
    expect(Math.min(box?.width ?? 0, box?.height ?? 0), "touch target").toBeGreaterThanOrEqual(44);
    await button.tap();
    await expect(menu(page)).toBeVisible();
    await expect(menu(page).getByRole("menuitem")).toHaveText(MENU);
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await menu(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    await page.screenshot({ path: test.info().outputPath("thread-menu-touch.png"), animations: "disabled" });
    await menu(page).getByRole("menuitem", { name: "Rename", exact: true }).tap();
    await expect(page.locator(".app.drawer")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Thread title" })).toHaveValue(OTHER);
    await expect(page.getByRole("textbox", { name: "Thread title" })).toBeFocused();
  });
});
