/// <reference lib="dom" />
// Thread actions live on the sidebar row, with a reserved slot so revealing
// the menu button cannot resize the title, timestamp, or row. A right-click
// opens the same menu at the pointer, and Export as Markdown makes no file for a
// thread deleted while its history loads.
import type { Download, Locator, Page } from "@playwright/test";
import { expect, test, waitReady } from "./fixtures.ts";
import { tap } from "./socket-tap.ts";

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

const rowNamed = (page: Page, title: string) => page.locator(".sb-row", { hasText: title });

/** Waits out a popover's open animation (it rises 4 px) before its box is measured. */
async function settled(el: Locator): Promise<void> {
  await el.evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished)));
}

/** Every download the page starts, from now on. */
function downloads(page: Page): Download[] {
  const got: Download[] = [];
  page.on("download", (d) => got.push(d));
  return got;
}

async function exportRow(page: Page, title: string): Promise<void> {
  await rowNamed(page, title).click({ button: "right" });
  await page.getByTestId("sidebar.thread-menu.export").click();
}

test.describe("right-click", () => {
  // Guards the owner's ask: right-click a thread for its menu.
  test("right-click a sidebar thread: its actions at the pointer; Rename renames that thread", async ({ page, open, seededThread }) => {
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    const popup = page.locator("#threadMenu");
    const target = rowNamed(page, "Fix the backup cron");
    const box = await target.boundingBox();
    if (!box) throw new Error("no row");
    const at = { x: box.x + 40, y: box.y + box.height / 2 };
    await page.mouse.click(at.x, at.y, { button: "right" });
    await expect(popup).toBeVisible();
    await expect(popup.getByRole("menuitem")).toHaveText(MENU);
    await settled(popup);
    const mb = await popup.boundingBox();
    expect(Math.abs((mb?.x ?? 0) - at.x), "menu at the pointer (x)").toBeLessThan(2);
    expect(Math.abs((mb?.y ?? 0) - at.y), "menu at the pointer (y)").toBeLessThan(2);
    // the thread under the pointer is not opened by the right-click, and its row is marked while the menu is open
    await expect(page.locator(".hdr h2")).toHaveText("Library: Effect Schema books");
    await expect(target.locator(".sb-menu")).toHaveAttribute("aria-expanded", "true");

    await page.getByTestId("sidebar.thread-menu.rename").click();
    const input = page.getByTestId("chat.header.title");
    await expect(input).toHaveValue("Fix the backup cron");
    await input.fill("Fix the nightly backup");
    await input.press("Enter");
    await expect(rowNamed(page, "Fix the nightly backup")).toBeVisible();
    await expect(rowNamed(page, "Fix the nightly backup").locator(".sb-menu")).toHaveAttribute("aria-expanded", "false");
    await expect(rowNamed(page, "Library: Effect Schema books")).toBeVisible();
    // the server has it
    await page.reload();
    await waitReady(page);
    await expect(rowNamed(page, "Fix the nightly backup")).toBeVisible();
  });
});

test.describe("Export as Markdown from the thread menu", () => {
  for (const preload of ["in flight", "cached"] as const) {
    // Guards a shipped bug: a pending hover load let an export finish after its thread was deleted.
    test(`deleting during export ignores hover history ${preload}`, async ({ page, open, seededThread }) => {
      const t = await tap(page);
      await open(`#thread=${seededThread ?? ""}`);
      await waitReady(page);
      await expect(page.locator(".tl .turn").first()).toBeVisible();
      const files = downloads(page);
      if (preload === "in flight") t.hold.add("threads.get");
      const before = t.calls.get("threads.get") ?? 0;
      await rowNamed(page, OTHER).hover();
      await expect.poll(() => t.calls.get("threads.get") ?? 0).toBe(before + 1);
      if (preload === "in flight") await expect.poll(() => t.queued("threads.get")).toBe(1);
      else await expect.poll(() => t.pending.size).toBe(0);

      // Hold the export independently: a completed hover is never its source.
      t.hold.add("threads.get");
      await exportRow(page, OTHER);
      const held = preload === "in flight" ? 2 : 1;
      await expect.poll(() => t.queued("threads.get")).toBe(held);
      // Model a delete requested before history arrives but confirmed after it.
      t.hold.add("threads.delete");
      t.hold.add("threads.changed");
      await rowNamed(page, OTHER).click({ button: "right" });
      await page.getByTestId("sidebar.thread-menu.delete").click();
      await expect.poll(() => t.queued("threads.delete")).toBe(1);
      expect(t.release("threads.get")).toBe(held);
      await expect.poll(() => t.pending.size).toBe(1);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(files).toHaveLength(0);
      expect(t.release("threads.delete")).toBe(1);
      expect(t.release("threads.changed")).toBe(1);
      await expect(rowNamed(page, OTHER)).toHaveCount(0);
      await expect(page.locator('.c-note[role="status"]')).toContainText("it was deleted");
      expect(files).toHaveLength(0);
    });
  }
});
