import { expect, sendMessage, test, waitReady } from "./fixtures.ts";

declare global { interface Window { completeDraftPaste: () => Promise<void>; } }

// Guards the owner's ask for a draft per thread, the way T3 Code keeps them.
test("each thread keeps its draft across switches, reload and sending the other draft", async ({ page, open }, info) => {
  await open(); await waitReady(page);
  await sendMessage(page, "First chat");
  await expect(page.locator(".turn.a")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  const a = page.url();
  await page.getByRole("button", { name: "New thread" }).click();
  await sendMessage(page, "Second chat");
  await expect(page.locator(".turn.a")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  const b = page.url();
  await page.goto(a); await waitReady(page);
  await page.locator("#ta").fill("A unfinished words");
  await page.locator(".sb-row", { hasText: "Second chat" }).click();
  await expect(page.locator("#ta")).toHaveValue("");
  await page.locator("#ta").fill("B unfinished words");
  await page.locator(".sb-row", { hasText: "First chat" }).click();
  await expect(page.locator("#ta")).toHaveValue("A unfinished words");
  expect(await page.locator("#ta").evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe("A unfinished words".length);
  // Wait for an actual completed persistence write before the reload.
  await expect.poll(() => page.evaluate(() => new Promise<unknown>(resolve => {
    const opening = indexedDB.open("gates-local.composer", 1);
    opening.onsuccess = () => {
      const db = opening.result;
      const key = new URL(new URL(location.href).searchParams.get("server")!).host;
      const tx = db.transaction("drafts");
      const read = tx.objectStore("drafts").get(key);
      read.onsuccess = () => { db.close(); resolve(JSON.stringify(read.result)); };
    };
  }))).toContain("B unfinished words");
  await page.reload(); await waitReady(page);
  await expect(page.locator("#ta")).toHaveValue("A unfinished words");
  await page.locator("#ta").press("Enter");
  await expect(page.locator("#ta")).toHaveValue("");
  await page.locator(".sb-row", { hasText: "Second chat" }).click();
  await expect(page.locator("#ta")).toHaveValue("B unfinished words");
  await page.evaluate(() => {
    const Reader = window.FileReader;
    window.FileReader = class extends Reader {
      override readAsDataURL(blob: Blob): void {
        window.completeDraftPaste = () => new Promise(resolve => {
          this.addEventListener("loadend", () => queueMicrotask(resolve), { once: true });
          super.readAsDataURL(blob);
        });
      }
    };
  });
  await page.locator("#ta").evaluate(el => {
    const data = new DataTransfer();
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg==";
    data.items.add(new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], "pixel.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.locator(".sb-row", { hasText: "First chat" }).click();
  await page.evaluate(() => window.completeDraftPaste());
  await expect(page.locator(".att img"), "M21: the image must stay out of the open chat").toHaveCount(0);
  await page.locator(".sb-row", { hasText: "Second chat" }).click();
  await expect(page.locator(".att img"), "M21: the pasted image belongs to its source chat").toHaveCount(1);
  await page.screenshot({ path: info.outputPath("thread-drafts.png") });
  expect(page.url()).toBe(b);
});
