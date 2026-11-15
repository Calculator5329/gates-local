/// <reference lib="dom" />
// Journey: context is one size across chats, set in the model picker (decision 13).
import { expect, test, waitReady } from "./fixtures.ts";

test.use({ comfyUrl: "http://127.0.0.1:9" });

// Guards what reads as the owner's decision that context is one size for all chats (unsure: could not find his line).
test("context is one size across chats", async ({ page, open }) => {
  await open();
  await waitReady(page);
  // a size picked in one chat is still the size in the next
  const contextMenu = async () => {
    await page.locator("#modelBtn").click();
    return page.locator("#picker").getByRole("radiogroup", { name: "Context" });
  };
  const first = await contextMenu();
  await first.getByRole("radio", { name: "8k" }).click();
  await expect(page.locator("#picker")).toBeHidden();
  await expect(page.locator("#modelBtn")).toContainText("8k");
  await page.keyboard.press("Control+n");
  const next = await contextMenu();
  await expect(next.getByRole("radio", { name: "8k" })).toHaveAttribute("aria-checked", "true");
});

// Guards the owner's ask: GPU memory lives in Settings > Advanced and updates live.
test("Settings > Advanced shows GPU memory, live", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await page.keyboard.press("Control+Comma");
  const nav = page.locator(".snav").getByRole("button");
  await expect(nav.last()).toHaveText("Shortcuts");
  await expect(page.getByTestId("settings.nav.open-memory")).toHaveCount(0);
  await page.getByTestId("settings.nav.open-advanced").click();
  const set = page.locator(".set");
  await expect(set.getByRole("heading", { name: "Advanced" })).toBeVisible();
  await expect(set.locator(".grp").first()).toContainText("GPU memory");
  await set.getByText("Details", { exact: true }).click();
  await expect(set.getByText("In use right now")).toBeVisible();
  await expect(set).toContainText("Qwen 3.5 9B");
  // context is set in the model picker only (decision 13); the verdict names the size it runs at
  await expect(set.locator("[data-ctx]")).toHaveCount(0);
  await expect(set.locator(".fp-v:visible")).toContainText("at 16k");
  await expect(set).not.toContainText("At 64k: ");
});
