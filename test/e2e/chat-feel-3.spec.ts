/// <reference lib="dom" />
// Export as Markdown from the thread menu makes no file for a thread deleted
// while its history loads, even when a hover already fetched that history.
//
// A stopped reply's seconds are the server's: the window that pressed Stop shows
// the number every other window and a reload show.
import type { Download, Page } from "@playwright/test";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";
import { tap } from "./socket-tap.ts";

const row = (page: Page, title: string) => page.locator(".sb-row", { hasText: title });

/** Every download the page starts, from now on. */
function downloads(page: Page): Download[] {
  const got: Download[] = [];
  page.on("download", (d) => got.push(d));
  return got;
}

async function exportRow(page: Page, title: string): Promise<void> {
  await row(page, title).click({ button: "right" });
  await page.getByTestId("sidebar.thread-menu.export").click();
}

test.describe("Export as Markdown from the thread menu", () => {
  test.use({ seed: "design" });
  const OTHER = "Fix the backup cron";

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
      await row(page, OTHER).hover();
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
      await row(page, OTHER).click({ button: "right" });
      await page.getByTestId("sidebar.thread-menu.delete").click();
      await expect.poll(() => t.queued("threads.delete")).toBe(1);
      expect(t.release("threads.get")).toBe(held);
      await expect.poll(() => t.pending.size).toBe(1);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(files).toHaveLength(0);
      expect(t.release("threads.delete")).toBe(1);
      expect(t.release("threads.changed")).toBe(1);
      await expect(row(page, OTHER)).toHaveCount(0);
      await expect(page.locator('.c-note[role="status"]')).toContainText("it was deleted");
      expect(files).toHaveLength(0);
    });
  }
});

const stopSecs = (page: Page) => page.locator(".turn.a").last().locator(".stop-mark .s");

// Guards one number for a stopped reply: the seconds are counted where the reply ran, not on the clock of the window that pressed Stop.
test("Stop on a slow connection shows the same seconds in the pressing window, a second window and after a reload", async ({ page, open, context }) => {
  test.setTimeout(60_000);
  const t = await tap(page);
  // the press reaches the server a second and a half after the click
  for (const method of ["chat.cancel", "reply.stop"]) t.late.set(method, 1500);
  await open();
  await waitReady(page);
  await stack.scenario("slow-drip", { holdAfterTokens: 46 });
  await sendMessage(page, "How do I check disk space before a download?");
  await expect(page.locator(".turn.a .md ul li")).toHaveCount(3, { timeout: 20_000 });

  const other = await context.newPage();
  await other.goto(page.url());
  await waitReady(other);
  await expect(other.locator(".turn.a .md ul li"), "the second window watches the same reply").toHaveCount(3, { timeout: 20_000 });

  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(stopSecs(page)).toHaveText(/^\d+ s$/);
  const pressed = (await stopSecs(page).textContent()) ?? "";
  await page.screenshot({ path: test.info().outputPath("pressing-window.png") });
  await expect(stopSecs(other), "the second window shows the pressing window's seconds").toHaveText(pressed);
  await other.screenshot({ path: test.info().outputPath("second-window.png") });
  // the saved row takes the live one's place without the number changing
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await expect(page.locator(".turn.a").last()).toHaveClass(/\binterrupted\b/);
  await expect(stopSecs(page), "the number never changes in the pressing window").toHaveText(pressed);

  await page.reload();
  await waitReady(page);
  await expect(stopSecs(page), "a reload shows the same seconds").toHaveText(pressed);
  await other.close();
});
