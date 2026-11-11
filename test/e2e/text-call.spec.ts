import { fakeComfy } from "./fake-comfy.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

test.use({ allowedErrors: [/WebSocket connection to .* failed/] });
let comfy: Awaited<ReturnType<typeof fakeComfy>>;
test.beforeEach(async () => { comfy = await fakeComfy(); });
test.afterEach(async () => { await comfy.close(); });

// A local model wrote its image call as the reply's text, { "action": "image", "action_input": "..." },
// with no runtime tool_calls. The app runs it as the image call it is; the JSON never shows.
test("an image call the model wrote as text queues the image and never shows its JSON", async ({ page, open }, info) => {
  await page.setViewportSize({ width: 1106, height: 1022 });
  await stack.reset("image-text-call", 0, undefined, "system", undefined, comfy.url);
  await open(); await waitReady(page);
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Image generation", exact: true }).click();
  await page.getByRole("switch", { name: "Generate images" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Image", exact: true }).click();
  // Watch every frame of the reply for the call's JSON while it streams.
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { jsonSeen: string[] }).jsonSeen = seen;
    new MutationObserver(() => {
      const text = document.querySelector(".tl")?.textContent ?? "";
      if (text.includes("action_input") || text.includes('{ "action"')) seen.push(text.slice(0, 80));
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await sendMessage(page, "A sci fi background image");
  const card = page.locator("[data-image-job]");
  const json = page.locator(".tl").getByText("action_input");
  await expect(card.or(json).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("textcall.png"), animations: "disabled" });
  expect(await page.evaluate(() => (window as unknown as { jsonSeen: string[] }).jsonSeen)).toEqual([]);
  await expect(card).toContainText("Making image");
  await expect(json).toHaveCount(0);
  comfy.finish();
  await expect(card.getByRole("img", { name: "Generated image" })).toBeVisible();
  await page.reload(); await waitReady(page);
  await expect(card.getByRole("img", { name: "Generated image" })).toBeVisible();
  await expect(page.locator(".tl")).not.toContainText("action_input");
});
