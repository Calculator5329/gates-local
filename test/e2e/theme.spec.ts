/// <reference lib="dom" />
// Journey: the theme. With nothing saved the app follows the OS; a theme
// picked in Settings › General is saved on the server (settings.update) and
// wins over the OS across a reload.
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
  // with nothing saved the picker shows System (the server's default theme)
  await expect(page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".set")).not.toContainText("not available in this build");
});

test("a theme picked in Settings persists across reload over the OS setting", async ({ page, open }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await open();
  await waitReady(page);
  await page.keyboard.press("Control+,");
  await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
