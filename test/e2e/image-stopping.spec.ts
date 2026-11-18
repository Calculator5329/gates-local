// A picture made on the processor, stopped. The engine ends the step it is in before it lets go,
// so the card says "Stopping the picture" in the box it already had, then settles to the stopped
// card in that same box. While it stops there is nothing more to press: the composer's Stop has
// gone with the turn and the card offers no Cancel. The picture's turn has not ended on the server
// yet, so a chat question sent in that chat waits behind it as a queued message, and the box empties.
import type { Page } from "@playwright/test";
import { createClient } from "@gates-local/contracts";
import { fakeComfy } from "./fake-comfy.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";
import { painted } from "./waits.ts";

test.use({ video: "off", allowedErrors: [/WebSocket connection to .* failed/] });
let comfy: Awaited<ReturnType<typeof fakeComfy>>;
// no gpu(): the fake engine reports the processor, and every setup's files let its default run there
test.beforeEach(async () => { comfy = await fakeComfy(); comfy.withApp(); });
test.afterEach(async () => { await comfy.close(); });

const STOPPING = "Stopping the picture";
const STOPPED = "The image was cancelled.";
const QUESTION = "What colour is a nebula?";
const PHONE = { width: 390, height: 844 };

/** Images on, Image mode on, one picture asked for on the processor; resolves once the engine runs it. */
async function picture(page: Page, open: () => Promise<void>) {
  await stack.reset("models", 0, undefined, "system", undefined, comfy.url);
  await open(); await waitReady(page);
  const server = new URL(page.url()).searchParams.get("server");
  if (!server) throw new Error("No test server URL");
  const client = createClient(new WebSocket(server));
  await client.call("settings.update", { imageGen: true });
  await page.getByTestId("chat.composer.image").click();
  await expect(page.locator("#modelBtn")).toContainText("General");
  await sendMessage(page, "a lighthouse at dusk");
  const card = page.locator("[data-image-job]");
  await expect(card.getByRole("status", { name: "Making image" })).toBeVisible();
  await expect.poll(() => comfy.state().length, { message: "the engine took the prompt" }).toBe(1);
  return { client, card };
}

/** The card with 16 px around it, outlined in amber, at the viewport it is in now. */
async function shot(page: Page, path: string) {
  await page.mouse.move(5, 5);
  const card = page.locator("[data-image-job]");
  await card.scrollIntoViewIfNeeded();
  await card.evaluate((el) => { (el as HTMLElement).style.outline = "2px solid #f59e0b"; (el as HTMLElement).style.outlineOffset = "4px"; });
  const box = await card.boundingBox();
  const view = page.viewportSize();
  if (!box || !view) throw new Error("no card");
  const x = Math.max(0, box.x - 16), y = Math.max(0, box.y - 16);
  await page.screenshot({ path, animations: "disabled", clip: { x, y, width: Math.min(view.width - x, box.width + 32), height: Math.min(view.height - y, box.height + 32) } });
  await card.evaluate((el) => { (el as HTMLElement).style.outline = ""; (el as HTMLElement).style.outlineOffset = ""; });
}

/** Desktop then phone width, back to desktop: the same card in both. Resolves once the desktop
 * width is drawn again: the timeline goes back to its end in that frame, not at the resize. */
async function shots(page: Page, name: string, path: (name: string) => string) {
  const desktop = page.viewportSize();
  if (!desktop) throw new Error("no viewport");
  await shot(page, path(`${name}-desktop.png`));
  await page.setViewportSize(PHONE);
  await shot(page, path(`${name}-phone.png`));
  await page.setViewportSize(desktop);
  await painted(page);
}

/** The card's box as drawn: read after a frame, so a change of its words has been laid out and the timeline kept at its end. */
async function drawnBox(page: Page, card: ReturnType<Page["locator"]>) {
  await painted(page);
  return card.boundingBox();
}

test("Stop on a processor picture: the card says it is stopping in its own box, then settles; nothing more to press meanwhile", async ({ page, open }, info) => {
  const { client, card } = await picture(page, open);
  try {
    // the engine holds the picture after the interrupt, as the processor ends the step it is in
    comfy.slowStop(120_000);
    const box = await drawnBox(page, card);
    const job = await card.getAttribute("data-job");
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(card.getByRole("status", { name: STOPPING })).toBeVisible();
    await expect(card.locator(".image-job-live")).toHaveText(new RegExp(`^${STOPPING} · \\d+ s$`));
    await expect.poll(() => comfy.stops().holding, { message: "the engine is still ending its step" }).toBe(1);
    expect(await drawnBox(page, card), "the stopping card keeps the running card's box").toEqual(box);
    await shots(page, "image-stopping", (n) => info.outputPath(n));
    expect(await card.boundingBox(), "back at the desktop width, the same box").toEqual(box);

    // a second Stop: the composer has none (the turn ended here at the first), the card has no Cancel,
    // and asking the server again changes nothing: one card, the same job, still stopping
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
    await expect(card.getByTestId("chat.image-job.action")).toHaveCount(0);
    expect(await client.call("image.cancel", { jobId: job ?? "" })).toEqual({ cancelled: true });
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute("data-job", job ?? "");
    await expect(card.getByRole("status", { name: STOPPING })).toBeVisible();
    expect(comfy.state(), "no new picture was asked for").toHaveLength(1);

    // a chat question in this chat meanwhile: the picture's turn is still open on the server, so the
    // question waits behind it, and the box is empty
    await page.getByTestId("chat.composer.image").click();
    await sendMessage(page, QUESTION);
    await expect(page.getByRole("listitem", { name: "Queued message 1 of 1" })).toBeVisible();
    await expect(page.locator("#ta")).toHaveValue("");
    await expect(card.getByRole("status", { name: STOPPING })).toBeVisible();
    // taken back, so nothing is sent below the card when the picture's turn ends
    await page.getByRole("listitem", { name: "Queued message 1 of 1" }).locator("[data-unqueue]").click();
    await expect(page.getByRole("listitem", { name: "Queued message 1 of 1" })).toHaveCount(0);

    // the engine lets go: the stopped card, in the same box, with Try again
    comfy.slowStop(0);
    await expect(card).toHaveAttribute("data-image-job", "cancelled");
    await expect(card).toContainText(STOPPED);
    await expect(card.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(await drawnBox(page, card), "the settled card keeps the box").toEqual(box);
    await shots(page, "image-stopped", (n) => info.outputPath(n));
  } finally { client.close(); }
});

// The control: the engine as it was faked before slowStop (it lets go at the interrupt), so the
// stopping card is never on screen long enough to see. This is the red the spec above turns green.
test("control: an engine that lets go at once shows no stopping card", async ({ page, open }) => {
  test.fail();
  const { client, card } = await picture(page, open);
  try {
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(card.getByRole("status", { name: STOPPING })).toBeVisible({ timeout: 3_000 });
    await expect.poll(() => comfy.stops().holding, { timeout: 2_000 }).toBe(1);
  } finally { client.close(); }
});
