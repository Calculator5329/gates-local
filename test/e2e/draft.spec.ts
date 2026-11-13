import type { Page } from "@playwright/test";
import { expect, test, waitReady } from "./fixtures.ts";

function metadata(target: Page) {
  return target.evaluate(() => new Promise<unknown>((resolve, reject) => {
    const opening = indexedDB.open("gates-local.composer", 1);
    opening.addEventListener("success", () => {
      const db = opening.result;
      const key = new URL(new URL(location.href).searchParams.get("server")!).host;
      const request = db.transaction("drafts").objectStore("drafts").get(key);
      request.addEventListener("success", () => { db.close(); resolve(request.result); }, { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    }, { once: true });
    opening.addEventListener("error", () => reject(opening.error), { once: true });
  }));
}
const saved = (target: Page, draft: string) => expect.poll(() => metadata(target)).toMatchObject({ draft });

// Guards a shipped bug fix: two tabs on one draft lost words or attachments.
test("two tabs keep the last writer's complete draft after another tab replaces or clears images", async ({ page, context, open }) => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg==";
  const addImages = async (target: Page, count: number) => {
    await target.locator("#ta").focus();
    await target.evaluate(({ image, amount }) => {
      const data = new DataTransfer();
      for (let i = 0; i < amount; i++) data.items.add(new File([Uint8Array.from(atob(image), c => c.charCodeAt(0))], `image-${i}.png`, { type: "image/png" }));
      document.querySelector("#ta")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, { image: png, amount: count });
    await expect(target.locator(".att img")).toHaveCount(count);
  };
  await open(); await waitReady(page);
  await addImages(page, 2);
  await page.locator("#ta").fill("A words"); await saved(page, "A words");
  const other = await context.newPage();
  try {
    await other.goto(page.url()); await waitReady(other);
    await expect(other.locator(".att img")).toHaveCount(2);
    for (let i = 0; i < 2; i++) await other.getByTestId("chat.attachment.remove-image-1").click();
    await addImages(other, 1);
    await other.locator("#ta").fill("B words"); await saved(other, "B words");
    await page.locator("#ta").fill("A final words"); await saved(page, "A final words");
    await page.reload(); await waitReady(page);
    await expect(page.locator("#ta")).toHaveValue("A final words");
    await expect(page.locator(".att img")).toHaveCount(2);
    await other.getByTestId("chat.attachment.remove-image-1").click();
    await other.locator("#ta").fill("B cleared"); await saved(other, "B cleared");
    await page.locator("#ta").fill("A words after B cleared"); await saved(page, "A words after B cleared");
    await page.reload(); await waitReady(page);
    await expect(page.locator("#ta")).toHaveValue("A words after B cleared");
    await expect(page.locator(".att img")).toHaveCount(2);
  } finally { await other.close(); }
});
