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
