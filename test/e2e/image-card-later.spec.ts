// A computer set up for pictures with no graphics card gets the processor build; a card that turns
// up later is never used by it. Settings › Image generation then says so in one line with one
// button, the same setup with its download said first. Pictures keep running on the processor
// until the card's build is in, and the processor's build stays where it was. The engine, its
// build and the model files are the test's fake ComfyUI's (fake-comfy.ts engine()); nothing is
// fetched from anywhere else.
import type { Page } from "@playwright/test";
import { fakeComfy } from "./fake-comfy.ts";
import { expect, stack, test, waitReady } from "./fixtures.ts";

test.use({ video: "off", allowedErrors: [[/WebSocket connection to .* failed/, /Failed to load resource.*503/], { scope: "test" }] });
let comfy: Awaited<ReturnType<typeof fakeComfy>>;
test.beforeEach(async () => { comfy = await fakeComfy(); comfy.down(true); comfy.bare(); comfy.withFolders(); });
test.afterEach(async () => { await comfy.close(); });

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

/** Settings › Image generation, through the list on a phone and the side nav elsewhere. */
async function images(page: Page) {
  if (await page.getByRole("dialog", { name: "Settings" }).count() > 0) {
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
  }
  await page.keyboard.press("Control+Comma");
  if ((page.viewportSize()?.width ?? 1440) <= 640) {
    await page.getByTestId("settings.shell.back").click();
    await page.getByTestId("settings.sections.open-images").click();
  } else await page.getByTestId("settings.nav.open-images").click();
}

/** The Generate images group with 16 px to spare, `marked` outlined in amber where it is shown. */
async function shot(page: Page, marked: string, path: string) {
  await page.mouse.move(5, 5);
  const group = page.locator(".grp", { has: page.getByTestId("settings.images.enable") });
  const outline = (show: boolean) => page.locator(marked).evaluateAll((els, lit) => {
    for (const el of els) { (el as HTMLElement).style.outline = lit ? "2px solid #f59e0b" : ""; (el as HTMLElement).style.outlineOffset = lit ? "2px" : ""; }
  }, show);
  await outline(true);
  const r = (await group.boundingBox())!;
  const x = Math.max(0, r.x - 16), y = Math.max(0, r.y - 16);
  await page.screenshot({ path, clip: { x, y, width: r.x + r.width + 16 - x, height: r.y + r.height + 16 - y }, animations: "disabled" });
  await outline(false);
}

/** The same shot at the desktop width and at the phone's, then back. */
async function shots(page: Page, marked: string, name: string, out: (file: string) => string) {
  await page.setViewportSize(DESKTOP);
  await images(page);
  await shot(page, marked, out(`${name}-desktop.png`));
  await page.setViewportSize(PHONE);
  await images(page);
  await shot(page, marked, out(`${name}-phone.png`));
  await page.setViewportSize(DESKTOP);
  await images(page);
}

test("a card that turns up after a processor setup: one line and one button set the card's build up, and pictures stay on the processor until it is in", async ({ page, open }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize(DESKTOP);
  // the server's GPU reading, as it pushes it: a card put in is seen at its next reading, not at once
  let vendor: unknown;
  page.on("websocket", (ws) => ws.on("framereceived", (f) => {
    try {
      const frame = JSON.parse(String(f.payload)) as { channel?: unknown; payload?: { vendor?: unknown } };
      if (frame.channel === "gpu.changed") vendor = frame.payload?.vendor;
    } catch { /* not a JSON frame */ }
  }));
  await stack.reset("models", 0, undefined, "system", undefined, undefined, false, "ready", comfy.engine({ build: true, cpu: true }));
  // set up with no card: the processor build, started with --cpu
  await stack.computer(32, "none");
  await open(); await waitReady(page);
  await images(page);
  await page.getByTestId("settings.images.set-up").click();
  await expect(page.getByTestId("settings.images.enable")).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => comfy.engineArgs()?.includes("--cpu"), { timeout: 10_000 }).toBe(true);
  await expect(page.getByTestId("settings.images.use-card")).toHaveCount(0);

  // the card is back: once the server has read it (a reading that began before the switch says the
  // GPU changed between its two looks, so names no card), reopening the section reads the setup again
  await stack.computer(32, "card");
  await expect.poll(() => vendor, { message: "the server reads the card", timeout: 15_000 }).toBe("nvidia");
  await images(page);
  const use = page.getByTestId("settings.images.use-card");
  await expect(use).toBeVisible({ timeout: 10_000 });
  const row = page.locator(".srow", { has: use });
  await expect(row).toContainText("Pictures run on the processor");
  await expect(row).toContainText("This computer has a graphics card now.");
  // the download is said before anything starts: the card's build (3 GiB of fake wheels and the two archives)
  await expect(page.getByTestId("settings.images.card-size")).toHaveText(/^\d+\.\d\sGB/);
  // both labels stay in the button so it keeps its width; the one not shown is hidden from its name
  await expect(use).toHaveAccessibleName("Use the card");
  await page.waitForTimeout(300);
  await shots(page, ".srow:has([data-testid='settings.images.use-card'])", "card-later-offer", (f) => info.outputPath(f));

  // the build is held: Image mode stays reachable, the engine is still the processor's
  comfy.holdSync(true);
  await page.getByTestId("settings.images.use-card").click();
  await expect(row).toContainText("Downloading the image engine");
  await expect(page.getByTestId("settings.images.enable")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat.composer.image")).toBeEnabled();
  await page.getByTestId("chat.composer.image").click();
  await expect(page.getByRole("dialog", { name: "Images are not set up" })).toHaveCount(0);
  expect(comfy.engineArgs()).toContain("--cpu");
  await page.getByTestId("chat.composer.image").click();

  comfy.holdSync(false);
  // the processor's engine was idle: it ends, and the card's build is what starts
  await expect.poll(() => comfy.engineArgs()?.includes("--cpu"), { timeout: 60_000 }).toBe(false);
  await images(page);
  await expect(page.getByTestId("settings.images.use-card")).toHaveCount(0);
  await expect(page.getByTestId("settings.images.enable")).toBeVisible();
  await shots(page, "[data-testid='settings.images.enable']", "card-later-after", (f) => info.outputPath(f));
});
