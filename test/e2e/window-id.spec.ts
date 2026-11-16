import type { Page } from "@playwright/test";
import { expect, test, waitReady } from "./fixtures.ts";

const windowOf = (target: Page) => target.evaluate(() => sessionStorage.getItem("gates-local-window"));

// Guards a review finding: a tab opened from another copies its sessionStorage, and with it the
// window the server keys edit ownership by.
test("a reload keeps its window, and a tab opened from it takes its own", async ({ page, open }) => {
  await open(); await waitReady(page);
  const first = await windowOf(page);
  expect(first).not.toBeNull();
  await page.reload(); await waitReady(page);
  expect(await windowOf(page)).toBe(first);
  const [copy] = await Promise.all([page.waitForEvent("popup"), page.evaluate(() => void window.open(location.href))]);
  try {
    await waitReady(copy);
    const own = await windowOf(copy);
    expect(own).not.toBeNull();
    expect(own).not.toBe(first);
    expect(await windowOf(page)).toBe(first);
  } finally { await copy.close(); }
});
