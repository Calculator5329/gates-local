// Images not set up (the owner's 0.2.1 screenshots on a fresh install, 2026-11-13: "I shouldn't be
// able to get here if it isn't set up"). With image generation on and no ComfyUI answering at its
// address, and none the app can start: the Image button opens a small pop-up instead of Image mode,
// the server refuses an image send, a picture that cannot start is a one-line card, and nothing a
// person reads names a service.
import type { Page } from "@playwright/test";
import { createClient } from "@gates-local/contracts";
import { fakeComfy } from "./fake-comfy.ts";
import { expect, stack, test, waitReady } from "./fixtures.ts";

test.use({ video: "off", allowedErrors: [/WebSocket connection to .* failed/, /Failed to load resource.*503/] });
let comfy: Awaited<ReturnType<typeof fakeComfy>>;
// an address that answers nothing but 503, as no ComfyUI at all: the app cannot start one there
test.beforeEach(async () => { comfy = await fakeComfy(); comfy.down(true); });
test.afterEach(async () => { await comfy.close(); });

/** `around` with 16 px to spare, `marked` outlined in amber: the part this change touched. */
async function shot(page: Page, around: string, marked: string, path: string) {
  await page.mouse.move(5, 5);
  await page.locator(around).first().evaluate((el) => el.scrollIntoView({ block: "center" }));
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

// Guards the owner's ask: Image mode is not reachable, and no picture-sized card, with no ComfyUI set up.
test("with no ComfyUI set up, Image opens a pop-up instead of Image mode, the server refuses an image send, and a picture that cannot start is one line", async ({ page, open }, info) => {
  await stack.reset("models", 0, undefined, "system", undefined, comfy.url);
  await open(); await waitReady(page);
  const server = new URL(page.url()).searchParams.get("server");
  if (!server) throw new Error("No test server URL");
  const client = createClient(new WebSocket(server));
  try {
    await client.call("settings.update", { imageGen: true });
    const { id: threadId } = await client.call("threads.create", {});
    await open(`#thread=${threadId}`); await waitReady(page);
    // a picture asked for anyway (the chat model's tool does so): it cannot start
    await client.call("image.generate", { threadId, prompt: "a lighthouse" });
    const card = page.locator("[data-image-job]");
    await expect(card).toHaveAttribute("data-image-job", "error");
    await shot(page, "[data-image-job]", "[data-image-job]", info.outputPath("unset-card.png"));
    const imageBtn = page.getByTestId("chat.composer.image");
    await imageBtn.click();
    await page.waitForTimeout(300);
    await shot(page, ".composer, #imageUnset.open", "#imageUnset.open, .composer .pill.gate[aria-label=Image]", info.outputPath("unset-composer.png"));

    // the card says it in one line, not in a 1024 box
    expect((await card.boundingBox())?.height ?? 0, "a one-line card").toBeLessThan(80);
    await expect(card).toContainText("Images are not set up on this computer.");
    // Image mode stays off; the pop-up says why, with Settings and Check again
    await expect(imageBtn).toHaveAttribute("aria-pressed", "false");
    const pop = page.getByRole("dialog", { name: "Images are not set up" });
    await expect(pop).toBeVisible();
    await expect(pop.getByRole("button", { name: "Open Settings" })).toBeVisible();
    await expect(pop.getByRole("button", { name: "Check again" })).toBeVisible();
    // no service and no unit name anywhere a person reads
    await expect(page.locator("body")).not.toContainText(/service/i);
    // the server refuses an image send: no card, no question kept; Send answers at once, and the refusal is the turn's end (chat row 32)
    const before = (await client.call("threads.get", { threadId })).messages.length;
    const ends: string[] = [];
    client.subscribe("chat.event", p => { if (p.threadId === threadId && p.event.type === "error") ends.push(p.event.message); });
    await client.call("chat.send", { threadId, content: "a ship", model: "qwen3.5:9b", numCtx: 16384, draw: { preset: "flux2-klein-4b", width: 1024, height: 1024 } });
    await expect.poll(() => ends).toEqual([expect.stringContaining("Images are not set up on this computer.")]);
    expect((await client.call("threads.get", { threadId })).messages).toHaveLength(before);
    // Check again while nothing answers: the pop-up stays, says so, and Image stays off
    await pop.getByRole("button", { name: "Check again" }).click();
    await expect(pop).toContainText("Still no answer.");
    await expect(imageBtn).toHaveAttribute("aria-pressed", "false");
    // ComfyUI answers now: Check again closes the pop-up and turns Image on
    comfy.down(false);
    await pop.getByRole("button", { name: "Check again" }).click();
    await expect(pop).toBeHidden();
    await expect(imageBtn).toHaveAttribute("aria-pressed", "true");
  } finally { client.close(); }
});
