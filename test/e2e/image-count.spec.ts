// Pictures per send (the owner's ask of 2026-11-12): in Image mode the Thinking circle is the count,
// its menu picks 1 to 4 by click or key with this computer's last time for the setup, Image off
// brings the bulb back, and each thread keeps its own count. A send of N is one card of N tiles
// made one after another; Stop keeps the finished ones, and Try again on a tile remakes that tile.
import type { Page } from "@playwright/test";
import { scenePng } from "../../apps/server/src/pictures/test-png.ts";
import { fakeComfy } from "./fake-comfy.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

test.use({ video: "off", allowedErrors: [/WebSocket connection to .* failed/] });
let comfy: Awaited<ReturnType<typeof fakeComfy>>;
// a GPU, and FLUX.2 Klein 4B's files: Image mode has a default to send (1024²), and the fake serves
// a picture that size, as ComfyUI would, so this computer's time for the setup can be found
test.beforeEach(async () => { comfy = await fakeComfy(); comfy.gpu(); comfy.picture(scenePng(1024, 1024, 200)); });
test.afterEach(async () => { await comfy.close(); });

/** A fresh app, image generation on in Settings, the composer switched to Image. */
async function imageMode(page: Page, open: () => Promise<void>) {
  await stack.reset("image-turn", 0, undefined, "system", undefined, comfy.url);
  await open(); await waitReady(page);
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Image generation", exact: true }).click();
  await page.getByRole("switch", { name: "Generate images" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Image", exact: true }).click();
}

/** `around` with 16 px to spare, `marked` outlined in amber: the part this change touched. */
async function shot(page: Page, around: string, marked: string, path: string) {
  await page.mouse.move(5, 5);
  await page.locator(around).first().evaluate((el) => el.scrollIntoView({ block: "center" }));
  const outline =(show: boolean) => page.locator(marked).evaluateAll((els, lit) => {
    for (const el of els) { (el as HTMLElement).style.outline = lit ? "2px solid #f59e0b" : ""; (el as HTMLElement).style.outlineOffset = lit ? "2px" : ""; }
  }, show);
  await outline(true);
  const boxes = (await page.locator(around).evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, r: r.right, b: r.bottom }; })));
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - 16), y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 16);
  const clip = { x, y, width: Math.max(...boxes.map((b) => b.r)) + 16 - x, height: Math.max(...boxes.map((b) => b.b)) + 16 - y };
  await page.screenshot({ path, clip, animations: "disabled" });
  await outline(false);
}

const countBtn = (page: Page) => page.locator("#countBtn");
const menu = (page: Page) => page.getByRole("menu", { name: "Pictures per send" });

// Guards the owner's ask: the count takes the Thinking circle's place in Image mode, and only there.
test("in Image mode the Thinking circle is the picture count; its menu picks by click or key, and Image off brings the bulb back", async ({ page, open }, info) => {
  await imageMode(page, open);
  await shot(page, ".composer", ".composer .pill.thinking", info.outputPath("count-1-composer.png"));
  await expect(countBtn(page)).toHaveAccessibleName("Pictures per send: 1");
  await expect(page.getByRole("button", { name: "Thinking" })).toHaveCount(0);
  await countBtn(page).click();
  await expect(menu(page).getByRole("menuitemradio")).toHaveText(["1 image", "2 images", "3 images", "4 images"]);
  await expect(menu(page).getByRole("menuitemradio", { name: "1 image" })).toHaveAttribute("aria-checked", "true");
  // nothing made on this computer yet: no times
  await expect(menu(page).locator("small")).toHaveCount(0);
  await menu(page).getByRole("menuitemradio", { name: "2 images" }).click();
  await expect(menu(page)).toBeHidden();
  await expect(countBtn(page)).toHaveAccessibleName("Pictures per send: 2");
  // keys 1 to 4 pick while it is open
  await countBtn(page).click();
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("4");
  await expect(menu(page)).toBeHidden();
  await expect(countBtn(page)).toHaveAccessibleName("Pictures per send: 4");
  await shot(page, ".composer", "#countBtn", info.outputPath("count-1-composer-after.png"));
  // Image off: the bulb is back; on again: the pick is still there
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await expect(page.getByRole("button", { name: "Thinking" })).toBeVisible();
  await expect(countBtn(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await expect(countBtn(page)).toHaveAccessibleName("Pictures per send: 4");
});

// Guards the owner's ask: the count is the thread's, saved with it; three or four tiles sit two by two.
test("each thread keeps its own count, after a reload too, and the menu shows this computer's time once one exists", async ({ page, open }, info) => {
  await imageMode(page, open);
  await countBtn(page).click();
  await menu(page).getByRole("menuitemradio", { name: "3 images" }).click();
  await sendMessage(page, "three lighthouses");
  const group = page.locator("[data-image-group]");
  await expect(group).toHaveCount(1);
  await expect(group.locator("[data-image-job]")).toHaveCount(3);
  comfy.finish();
  // one after another, each polled to its end: longer than one picture's wait
  await expect(group.getByRole("img", { name: "Generated image" })).toHaveCount(3, { timeout: 15_000 });
  await expect(group.locator(".image-group-head")).toHaveText(/Klein 4B · .+ · 3 of 3 · \d+ s$/);
  // two by two: the third tile starts a second row under the first
  const tiles = await group.locator("[data-image-job]").evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ x: Math.round(r.x), y: Math.round(r.y) })));
  expect(tiles[1]!.y).toBe(tiles[0]!.y);
  expect(tiles[2]!.x).toBe(tiles[0]!.x);
  expect(tiles[2]!.y).toBeGreaterThan(tiles[0]!.y);
  // two by two is taller than the test window: a taller one for the shot
  await page.setViewportSize({ width: page.viewportSize()?.width ?? 1280, height: 1200 });
  await shot(page, "[data-image-group]", "[data-image-group]", info.outputPath("count-2-three-tiles.png"));
  // a new thread starts at 1; the first is still 3, after a reload too
  await page.getByRole("button", { name: "New thread" }).click();
  await expect(countBtn(page)).toHaveAccessibleName("Pictures per send: 1");
  await page.locator(".sb-row", { hasText: "three lighthouses" }).click();
  await expect(countBtn(page)).toHaveAccessibleName("Pictures per send: 3");
  // a reload starts with Image off, as before; switched on, the thread's 3 is back
  await page.reload(); await waitReady(page);
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await expect(countBtn(page)).toHaveAccessibleName("Pictures per send: 3");
  // a picture of this setup exists now: each row has a time
  await countBtn(page).click();
  await expect(menu(page).locator("small")).toHaveText(Array.from({ length: 4 }, () => /^~\d+ (s|min)$/));
  await shot(page, "#countMenu, #countBtn", "#countMenu", info.outputPath("count-2-menu-times.png"));
});

// Guards the owner's ask: one card per send, tiles fill in as each finishes, Stop keeps the finished
// ones, and Try again remakes only its own tile.
test("a send of two is one card of two tiles in a row; Stop keeps the finished one and Try again remakes only the other", async ({ page, open }, info) => {
  await imageMode(page, open);
  // the count left at 1: one picture, its own card, as before
  await sendMessage(page, "one lighthouse");
  const cards = page.locator("[data-image-job]");
  await expect.poll(() => comfy.state().length).toBe(1);
  comfy.finish(comfy.state()[0]!.id);
  await expect(cards).toHaveAttribute("data-image-job", "done");
  await shot(page, "[data-image-job]", "[data-image-job]", info.outputPath("count-3-one.png"));
  await expect(page.locator("[data-image-group]")).toHaveCount(0);
  await countBtn(page).click();
  await menu(page).getByRole("menuitemradio", { name: "2 images" }).click();
  await sendMessage(page, "two lighthouses");
  const group = page.locator("[data-image-group]");
  const head = group.locator(".image-group-head");
  const tiles = group.locator("[data-image-job]");
  await expect(tiles).toHaveCount(2);
  await expect(head).toHaveText(/· 0 of 2 making…$/);
  const [a, b] = await tiles.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().y)));
  expect(b, "two tiles share a row").toBe(a);
  // one after another: the second waits for the first
  await expect.poll(() => comfy.state().length).toBe(2);
  comfy.finish(comfy.state()[1]!.id);
  await expect(tiles.nth(0).getByRole("img", { name: "Generated image" })).toBeVisible();
  await expect(head).toHaveText(/· 1 of 2 making…$/);
  await expect.poll(() => comfy.state().length).toBe(3);
  await shot(page, "[data-image-group]", "[data-image-group]", info.outputPath("count-3-making.png"));
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(tiles.nth(1).getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(tiles.nth(0).getByRole("img", { name: "Generated image" })).toBeVisible();
  // the finished picture's time stays; the stopped one adds none
  await expect(head).toHaveText(/· 1 of 2 · \d+ s$/);
  const kept = await tiles.nth(0).getAttribute("data-job");
  await tiles.nth(1).getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => comfy.state().length).toBe(4);
  comfy.finish();
  await expect(tiles.nth(1).getByRole("img", { name: "Generated image" })).toBeVisible();
  await expect(head).toHaveText(/· 2 of 2 · \d+ s$/);
  await expect(tiles.nth(0)).toHaveAttribute("data-job", kept ?? "");
  await expect(group).toHaveCount(1);
  await expect(tiles).toHaveCount(2);
  await shot(page, "[data-image-group]", "[data-image-group]", info.outputPath("count-3-two-after.png"));
});
