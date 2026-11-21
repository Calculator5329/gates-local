// Journey: threads older than a week sit behind a folded "Older" heading that shows
// their count. Pressing it shows them, and it stays as left across a reload.
import { expect, test, waitReady } from "./fixtures.ts";

/** Thu 2026-11-12 14:00 in Chicago, as in the screenshot rig. */
const NOW = Date.UTC(2026, 10, 12, 20, 0);
const OLD = "Draft the drive-sync README";

test.use({ seed: "design", seedAt: NOW, timezoneId: "America/Chicago", locale: "en-US" });

test("Older starts folded with its count, opens on a press and stays as left after a reload", async ({ page, open }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.clock.setFixedTime(NOW);
  await open();
  await waitReady(page);
  const list = page.locator(".sb .sb-list");
  const fold = page.getByTestId("sidebar.older.toggle");
  const old = list.locator(".sb-row", { hasText: OLD });

  await expect(fold).toHaveAccessibleName("Older, 1 thread");
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(old).toHaveCount(0);
  const folded = await fold.boundingBox();

  await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(old).toBeVisible();
  expect(await fold.boundingBox(), "the heading holds still when it opens").toEqual(folded);

  await page.reload();
  await waitReady(page);
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(old).toBeVisible();

  await fold.click();
  await expect(old).toHaveCount(0);
  await page.reload();
  await waitReady(page);
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(old).toHaveCount(0);

  // a search looks through folded threads too
  await page.locator("#searchIn").fill("drive-sync");
  await expect(old).toBeVisible();
  await expect(fold).toHaveCount(0);
});
