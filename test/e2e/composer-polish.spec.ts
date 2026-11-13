/// <reference lib="dom" />
// Files arrive through the + menu's chooser: an image becomes a chip, a
// document is refused at its chip.
import type { Page } from "@playwright/test";
import { expect, test, waitReady } from "./fixtures.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg==";

async function chooseFiles(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.locator("#plusBtn").click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#plusMenu [data-attach]").click();
  await (await chooser).setFiles(files);
}

// Guards the owner's ask: images and files can be attached to a message.
test("Attach a file opens the chooser; an image becomes a chip and a document is refused at its chip", async ({ page, open }) => {
  await open(); await waitReady(page);
  await chooseFiles(page, [{ name: "shot.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") }]);
  await expect(page.locator(".att img")).toHaveCount(1);
  await chooseFiles(page, [{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("some notes\n") }]);
  const chip = page.locator(".att .attachment.file");
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText("notes.txt");
  await expect(chip).toHaveAttribute("data-tip", /Library/);
  await expect(chip.getByRole("button", { name: /Add .* to your Library/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toHaveAttribute("aria-disabled", "true");
  await chip.getByRole("button", { name: "Remove notes.txt" }).click();
  await expect(chip).toHaveCount(0);
  // The image is a draft attachment like a pasted one: it survives a reload.
  await page.reload(); await waitReady(page);
  await expect(page.locator(".att img")).toHaveCount(1);
});
