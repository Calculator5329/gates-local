// Journey: Settings › Models. The Installed tab lists what is installed, the
// row menu makes another model the default, the Download tab downloads a
// recommended model to its "is ready" card, and Start chat opens a new chat
// on that model rather than on the default.
import { expect, test, waitReady } from "./fixtures.ts";

test("set a default from the row menu, download a model, and start a chat on it", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Models", exact: true }).click();

  const installedTab = page.getByRole("tab", { name: /^Installed/ });
  await expect(installedTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".mp-row[data-dm]")).toHaveCount(3);
  await expect(page.locator('.mp-row[data-dm="qwen3.5:9b"] .mp-l1 .mp-chip')).toHaveText("Default");

  // another default, from the row menu
  const gemma = page.locator('.mp-row[data-dm="gemma4:12b"]');
  await gemma.getByRole("button", { name: "More for Gemma 4 12B" }).click();
  await page.getByRole("menuitem", { name: "Use as default" }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(gemma.locator(".mp-l1 .mp-chip")).toHaveText("Default");
  await expect(page.getByRole("button", { name: /^Default for new chats:/ })).toHaveAccessibleName("Default for new chats: Gemma 4 12B");

  // download a recommended model
  await page.getByRole("tab", { name: /^Download/ }).click();
  await expect(page.getByRole("region", { name: /^Recommended for / })).toBeVisible();
  await page.getByRole("button", { name: "Download Qwen 3.5 4B" }).click();
  const ready = page.locator('.mp-ready[data-pull="qwen3.5:4b"]');
  await expect(ready).toContainText("Qwen 3.5 4B is ready", { timeout: 20_000 });
  await expect(installedTab).toContainText("4");

  // Start chat opens a new chat on the downloaded model, not on the new default
  await ready.getByRole("button", { name: "Start chat" }).click();
  await expect(page.locator(".mp")).toHaveCount(0);
  await expect(page.locator("#modelBtn")).toContainText("Qwen 3.5 4B");
  await expect(page.locator("#modelBtn")).not.toContainText("Gemma");
});
