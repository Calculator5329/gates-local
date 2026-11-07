/// <reference lib="dom" />
// Journey: the theme. This build's server does not answer settings.*, so the
// app follows the OS and Settings › General says changing it is not
// available; the fixme twin is the saved-theme journey for when it lands.
import { expect, test, waitReady } from "./fixtures.ts";

const bodyBg = () => getComputedStyle(document.body).backgroundColor;

test("with no saved theme the app follows the OS, across a reload", async ({ page, open }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await open();
  await waitReady(page);
  const light = await page.evaluate(bodyBg);
  await page.emulateMedia({ colorScheme: "dark" });
  const dark = await page.evaluate(bodyBg);
  expect(light).not.toBe(dark);

  await page.reload();
  await waitReady(page);
  expect(await page.evaluate(bodyBg)).toBe(dark);
  await page.emulateMedia({ colorScheme: "light" });
  expect(await page.evaluate(bodyBg)).toBe(light);

  await page.keyboard.press("Control+,");
  await expect(page.getByRole("heading", { name: "General" })).toBeVisible();
  await expect(page.locator(".set")).toContainText("Changing it is not available in this build.");
});

test.fixme("a theme picked in Settings persists across reload over the OS setting (needs settings.update)", async ({ page, open }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await open();
  await waitReady(page);
  await page.keyboard.press("Control+,");
  await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
