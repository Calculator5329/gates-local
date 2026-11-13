// Tools › Make images with a fake chat model (the image-batch scenario). Once a setup can run, the
// switch is on with no click. "5 images of sci-fi backgrounds" is one image call with five prompts
// the model wrote: five jobs, in order, each card with its own prompt under it. Switched off, the
// system prompt's one line has the model name the setting, never another app.
import type { Page } from "@playwright/test";
import { createClient } from "@gates-local/contracts";
import { fakeComfy } from "./fake-comfy.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

test.use({ video: "off" });
let comfy: Awaited<ReturnType<typeof fakeComfy>>;
// a GPU, and FLUX.2 Klein 4B's files: a setup can run
test.beforeEach(async () => { comfy = await fakeComfy(); comfy.gpu(); });
test.afterEach(async () => { await comfy.close(); });

const SCENES = ["a ringed planet over a desert city", "a derelict station in a violet nebula", "a neon canyon of stacked towers", "an ice moon under twin suns", "a jungle overgrowing a crashed freighter"];

/** A fresh app on the image-batch model, image generation turned on in Settings, then Tools, where Make images is read. */
async function imageGenOn(page: Page, open: () => Promise<void>) {
  await stack.reset("image-batch", 0, undefined, "system", undefined, comfy.url);
  await open(); await waitReady(page);
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Image generation", exact: true }).click();
  await page.getByRole("switch", { name: "Generate images" }).click();
  await page.locator(".snav").getByRole("button", { name: "Tools", exact: true }).click();
  return page.getByRole("switch", { name: "Make images" });
}

async function outlined(page: Page, selector: string, path: string) {
  const marked = page.locator(selector);
  await marked.evaluateAll((els) => { for (const el of els) { (el as HTMLElement).style.outline = "2px solid #f59e0b"; (el as HTMLElement).style.outlineOffset = "2px"; } });
  await page.screenshot({ path, animations: "disabled" });
  await marked.evaluateAll((els) => { for (const el of els) { (el as HTMLElement).style.outline = ""; (el as HTMLElement).style.outlineOffset = ""; } });
}

// Guards the owner's ask for image batches: Make images is on once a setup runs, and five asked for are five cards.
test("Make images is on once a setup can run, and five images asked for are five cards in order, each with its own prompt", async ({ page, open }, info) => {
  const make = await imageGenOn(page, open);
  // soft: the five cards are checked whatever the switch said
  await expect.soft(make, "on with no click once a setup can run").toHaveAttribute("aria-checked", "true");
  await outlined(page, '.srow[data-tool="images"]', info.outputPath("image-9-after-tools.png"));
  await page.keyboard.press("Escape");
  await sendMessage(page, "5 images of sci-fi backgrounds");
  await expect(page.locator("[data-image-job]")).toHaveCount(5);
  await expect(page.locator(".image-job-prompt")).toHaveText(SCENES.map((scene) => `sci-fi backgrounds: ${scene}`));
  await page.mouse.move(5, 5);
  await outlined(page, ".image-job-prompt", info.outputPath("image-9-after-five.png"));
});

// Guards the owner's ask: with Make images off, the reply names the setting, never another app.
test("with Make images switched off, the reply names the setting, never another app", async ({ page, open }, info) => {
  const make = await imageGenOn(page, open);
  // switched off over the socket, so the test does not race the switch's first state
  const server = new URL(page.url()).searchParams.get("server");
  if (!server) throw new Error("No test server URL");
  const client = createClient(new WebSocket(server));
  try { await client.call("settings.update", { imageTool: false }); } finally { client.close(); }
  await expect(make).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await sendMessage(page, "Make an image of a lighthouse");
  const reply = page.locator(".turn.a").last();
  await expect(reply).toContainText("Turn on Make images in Settings > Tools, or switch the message box to Image.");
  await expect(reply).not.toContainText("app such as");
  await expect(page.locator("[data-image-job]")).toHaveCount(0);
  await outlined(page, ".turn.a .md", info.outputPath("image-9-after-off.png"));
});
