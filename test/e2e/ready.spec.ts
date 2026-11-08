/// <reference lib="dom" />
// Journey: the moment the runtime dot turns ready, the composer already has a
// model, so a message typed then sends. The model choice needs only
// models.list and settings.get; it must not wait for gpu.status or the
// catalog (apps/web/src/session.ts hydrate).
import { expect, sendMessage, test } from "./fixtures.ts";

/** Record the model label in the first DOM state that shows the ready dot. */
function watchReady(): void {
  const w = window as unknown as { glReadyModel?: string | null };
  const seen = () => {
    if (w.glReadyModel !== undefined || document.querySelector(".sb-foot .rt .dot.ok") === null) return;
    w.glReadyModel = document.querySelector("#modelBtn span")?.textContent ?? null;
  };
  new MutationObserver(seen).observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
}

test("the ready dot and a chosen model appear in the same render, and a message sent at once goes out", async ({ page, open }) => {
  await page.addInitScript(watchReady);
  await open();
  await expect(page.locator(".sb-foot .rt .dot.ok")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { glReadyModel?: string | null }).glReadyModel)).toBe("Qwen 3.5 9B");
  await sendMessage(page, "Right away");
  await expect(page.locator(".turn.a .md").last()).toContainText("You asked: Right away", { timeout: 10_000 });
});
