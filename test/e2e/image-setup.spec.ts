// Set up images (row 14, the owner's "A" on row 13: the app fetches and runs its own ComfyUI).
// The pop-up the Image button opens with nothing set up offers one download, the image engine and
// the recommended setup, and one click fetches both, starts the engine and turns Image on. Where
// pictures cannot run, it says why in plain words and offers nothing. The engine and the model
// files are the test's fake ComfyUI's (fake-comfy.ts engine()); nothing is fetched from anywhere else.
import type { Page } from "@playwright/test";
import { createClient } from "@gates-local/contracts";
import { fakeComfy } from "./fake-comfy.ts";
import { expect, stack, test, waitReady } from "./fixtures.ts";

// a list of two is passed as [value, options], so the value is wrapped (a bare pair reads as one pattern and its options)
test.use({ video: "off", allowedErrors: [[/WebSocket connection to .* failed/, /Failed to load resource.*503/], { scope: "test" }] });
let comfy: Awaited<ReturnType<typeof fakeComfy>>;
// no engine runs until the app starts its own: the fake answers nothing but 503 until then
test.beforeEach(async () => { comfy = await fakeComfy(); comfy.down(true); comfy.bare(); comfy.withFolders(); });
test.afterEach(async () => { await comfy.close(); });

/** `around` with 16 px to spare, `marked` outlined in amber: the part this change touched. */
async function shot(page: Page, around: string, marked: string, path: string) {
  await page.mouse.move(5, 5);
  const outline = (show: boolean) => page.locator(marked).evaluateAll((els, lit) => {
    for (const el of els) { (el as HTMLElement).style.outline = lit ? "2px solid #f59e0b" : ""; (el as HTMLElement).style.outlineOffset = lit ? "2px" : ""; }
  }, show);
  await outline(true);
  const boxes = await page.locator(around).evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, r: r.right, b: r.bottom }; }));
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - 16), y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 16);
  const clip = { x, y, width: Math.max(...boxes.map((b) => b.r)) + 16 - x, height: Math.max(...boxes.map((b) => b.b)) + 16 - y };
  await page.screenshot({ path, clip, animations: "disabled" });
  await outline(false);
}

/** A fresh stack whose own engine is the fake's, image generation on, and the Image pop-up open. */
async function openPopUp(page: Page, open: (hash?: string) => Promise<void>, cardMib?: number) {
  await stack.reset("models", 0, undefined, "system", undefined, undefined, false, "ready", comfy.engine());
  if (cardMib !== undefined) await stack.gpu(0, cardMib);
  await open(); await waitReady(page);
  const server = new URL(page.url()).searchParams.get("server");
  if (!server) throw new Error("No test server URL");
  const client = createClient(new WebSocket(server));
  try { await client.call("settings.update", { imageGen: true }); } finally { client.close(); }
  const imageBtn = page.getByTestId("chat.composer.image");
  await imageBtn.click();
  const pop = page.getByRole("dialog", { name: "Images are not set up" });
  await expect(pop).toBeVisible();
  return { imageBtn, pop };
}

// Guards the owner's ask: one click sets up images.
test("one click sets up images: the pop-up shows the one download, Set up images fetches the engine and the model, and Image turns on", async ({ page, open }, info) => {
  const { imageBtn, pop } = await openPopUp(page, open);
  const plan = pop.locator("#imageSetupPlan");
  await expect(plan).toContainText("FLUX.2 Klein 4B");
  await expect(plan).toContainText("With the image engine (ComfyUI 0.0.0-test)");
  const setUp = pop.getByTestId("image.unset.set-up");
  await expect(setUp).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, "#imageUnset.open", "#imageSetupPlan, #imageUnset .unset-acts .btn:first-child", info.outputPath("setup-offer.png"));

  // the model download held part way, to see the progress the click starts
  comfy.slowDownloads(true);
  await setUp.click();
  const run = pop.locator("#imageSetupRun");
  await expect(run).toContainText("Downloading the image model");
  await expect(pop.getByRole("progressbar", { name: "Image setup" })).toBeVisible();
  await expect(pop.getByRole("button", { name: "Setting up…" })).toBeDisabled();
  await shot(page, "#imageUnset.open", "#imageSetupRun", info.outputPath("setup-running.png"));
  // the model downloads with the engine stopped: a download never needs it (WIN-SETUP-01)
  expect(comfy.engineArgs(), "no engine started for the download").toBeUndefined();

  comfy.slowDownloads(false);
  await expect(pop).toBeHidden();
  await expect(imageBtn).toHaveAttribute("aria-pressed", "true");
  // then the engine the app started runs on the graphics card, at its own port
  expect(comfy.engineArgs()).toEqual(expect.arrayContaining(["--port"]));
  expect(comfy.engineArgs()).not.toContain("--cpu");
  // the composer's model button names the picture model from the start, never "Image model"
  await expect(page.locator("#modelBtn")).not.toContainText("Image model");
  await expect(page.locator("#modelBtn")).toHaveAttribute("data-tip", /Klein/);
});

// Guards F-7 of the fresh-install audit: on Linux the engine is built by a package sync that
// reports no bytes, and the count sat at 0.0 GB for the whole download. The count follows the
// sync's own lines now: one wheel in, its size shows; no number is ever a zero held throughout.
test.describe("at 1024 wide", () => {
  test.use({ viewport: { width: 1024, height: 768 } });
  test("setting up on Linux, the count moves as the engine's packages arrive", async ({ page, open }, info) => {
    await stack.reset("models", 0, undefined, "system", undefined, undefined, false, "ready", comfy.engine({ build: true }));
    comfy.holdSync(true);
    await open(); await waitReady(page);
    await page.keyboard.press("Control+Comma");
    await page.getByTestId("settings.nav.open-images").click();
    await page.getByTestId("settings.images.set-up").click();
    const row = page.locator(".srow", { has: page.getByTestId("settings.images.set-up") });
    await expect(row).toContainText("Downloading the image engine");
    const size = page.getByTestId("settings.images.setup-size");
    // the first wheel (1.0 GB) is in and the sync is held before the second
    const counted = await expect(size).toHaveText(/^1\.0\sGB of \d+\.\d\sGB$/, { timeout: 10_000 }).then(() => true, () => false);
    await shot(page, ".srow:has([data-testid='settings.images.set-up'])", "[data-testid='settings.images.setup-size']", info.outputPath("row5.png"));
    expect(counted, `the count with one wheel in: ${await size.textContent()}`).toBe(true);
    comfy.holdSync(false);
    await expect(page.getByTestId("settings.images.enable")).toBeVisible({ timeout: 60_000 });
  });
});

// Guards the owner's ask: where images cannot run, the app says so plainly.
test("where pictures cannot run, the pop-up says why in plain words and offers no download", async ({ page, open }, info) => {
  const { imageBtn, pop } = await openPopUp(page, open, 3072);
  await expect(pop.locator("#imageSetupWhy")).toHaveText("This graphics card has 3 GB; Image mode needs 4 GB. A ComfyUI on another computer works too: set its address in Settings.");
  await expect(pop.getByRole("button", { name: "Set up images" })).toHaveCount(0);
  await expect(pop.locator("#imageSetupPlan")).toHaveCount(0);
  await page.waitForTimeout(300);
  await shot(page, "#imageUnset.open", "#imageSetupWhy", info.outputPath("setup-cannot.png"));
  await expect(imageBtn).toHaveAttribute("aria-pressed", "false");
  expect(comfy.engineArgs(), "no engine started").toBeUndefined();
});
