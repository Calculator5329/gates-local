/// <reference lib="dom" />
// Journey: the theme. With nothing saved the app is dark; System follows the
// OS, and a theme picked in Settings › General is saved on the server
// (settings.update) and wins over the OS across a reload.
import { expect, test, waitReady } from "./fixtures.ts";

const bodyBg = () => getComputedStyle(document.body).backgroundColor;

// Guards the dark-by-default theme (unsure: no ruling of the owner's found, only the shipped default).
test("with no saved theme the app is dark whatever the OS says, and System follows the OS", async ({ page, open }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await open();
  await waitReady(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const dark = await page.evaluate(bodyBg);

  await page.keyboard.press("Control+,");
  await expect(page.getByRole("heading", { name: "General" })).toBeVisible();
  const theme = page.getByRole("group", { name: "Theme" });
  await expect(theme.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".set")).not.toContainText("not available in this build");

  await theme.getByRole("button", { name: "System" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /./);
  const light = await page.evaluate(bodyBg);
  expect(light).not.toBe(dark);
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await page.evaluate(bodyBg)).toBe(dark);

  await page.reload();
  await waitReady(page);
  expect(await page.evaluate(bodyBg)).toBe(dark);
  await page.emulateMedia({ colorScheme: "light" });
  expect(await page.evaluate(bodyBg)).toBe(light);
  await test.step("a picked theme survives reload over the OS setting", async () => {
    await page.keyboard.press("Control+,");
    await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Light" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
});
