/// <reference lib="dom" />
// Journey: Default context is one size across chats, and Settings says so.
import { expect, openGpuMemory, test, waitReady } from "./fixtures.ts";

test.use({ comfyUrl: "http://127.0.0.1:9" });

// Guards what reads as the owner's decision that context is one size for all chats (unsure: could not find his line).
test("context is one size across chats, and Settings says so", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const gpu = await openGpuMemory(page);
  const desc = gpu.locator(".srow", { hasText: "Default context" }).locator(".sl .d").first();
  await expect(desc).toContainText("One size for every chat");
  await expect(desc).not.toContainText("each chat");
  await page.keyboard.press("Escape");

  // what those words promise: a size picked in one chat is still the size in the next
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
