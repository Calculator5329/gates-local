// Journeys for what the user sees when a capability is not there (W-12):
// a Library with no sources, image generation with no ComfyUI, and a live
// tool step that cannot run. Each checks the explanation on screen and that
// the chat still ends on its own. The full flows are fixme twins below.
//
// ComfyUI's address here is 127.0.0.1:9, where nothing listens. A custom
// address also keeps the image module off the managed comfyui.service, so no
// systemctl call runs. No test here queues an image job: the job's GPU check
// runs the real nvidia-smi (main.ts does not hand GATES_LOCAL_NVIDIA_SMI to
// the image module), which the e2e stack must never touch.
import type { Page } from "@playwright/test";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

const DEAD_COMFY = "http://127.0.0.1:9";

const section = async (page: Page, label: string) => {
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: label, exact: true }).click();
};

/**
 * The one reply of a new thread ended by itself: its row is a finished turn
 * (.done), nothing is live, no error line, Send is back. Right after Send the
 * live row does not exist yet, so "no caret" alone would pass at once.
 */
async function replyEnded(page: Page, timeout = 15_000): Promise<void> {
  await expect(page.locator(".turn.a.done")).toHaveCount(1, { timeout });
  await expect(page.locator(".turn.a:not(.done)")).toHaveCount(0);
  await expect(page.locator(".caret")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  await expect(page.locator(".err-line")).toHaveCount(0);
}

/** Image generation on, pointed at an address where nothing answers; back in the chat with Image on. */
async function imageWithNoComfy(page: Page): Promise<void> {
  await section(page, "Image generation");
  // the address first: with generation still off, saving it reaches nothing
  const address = page.getByRole("textbox", { name: "ComfyUI address" });
  await address.fill(DEAD_COMFY);
  await address.press("Tab");
  await expect(address).toHaveValue(DEAD_COMFY);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("switch", { name: "Generate images" }).click();
  await expect(page.getByRole("switch", { name: "Generate images" })).toHaveAttribute("aria-checked", "true");
}

test("a Library with no sources says nothing is connected, and a chat that asks for a tool still answers", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await page.locator("#plusBtn").click();
  await page.getByRole("menuitem", { name: /Add to library/ }).click();
  await expect(page.locator(".snav").getByRole("button", { name: "Library", exact: true })).toHaveClass(/on/);
  await expect(page.getByText("Everything here is read-only; nothing is connected on its own.")).toBeVisible();
  await expect(page.locator(".badge", { hasText: "read-only" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add folder…" })).toBeVisible();

  await page.keyboard.press("Escape");
  await waitReady(page);
  // fast tokens: were a tool offered, the fake's tool loop would end quickly and show its rows
  await stack.scenario("models", { tokenDelayMs: 1, firstTokenDelayMs: 0 });
  await sendMessage(page, "Use a tool to search my notes");
  const reply = page.locator(".turn.a").last();
  await replyEnded(page);
  // with nothing in the Library no tool is offered: a plain answer, no tool row
  await expect(reply.locator(".md")).toContainText("You asked: Use a tool to search my notes.");
  await expect(reply.locator(".wr")).toHaveCount(0);
});

test("image generation with no ComfyUI says none was found, and a chat with Image on still finishes", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await imageWithNoComfy(page);
  const install = page.locator(".srow", { hasText: "ComfyUI install" });
  await expect(install).toContainText("No ComfyUI install was found.");
  await expect(install).toContainText("ComfyUI did not answer.");
  await expect(install).toContainText(DEAD_COMFY);

  await page.keyboard.press("Escape");
  await waitReady(page);
  const pill = page.getByRole("button", { name: "Image", exact: true });
  await pill.click();
  await expect(pill).toHaveAttribute("aria-pressed", "true");
  await sendMessage(page, "Describe a lighthouse at dusk");
  await replyEnded(page);
  await expect(page.locator(".turn.a").last().locator(".md")).toContainText("You asked: Describe a lighthouse at dusk.");
  // the model asked for no picture, so no job was queued and none is pending
  await expect(page.locator(".turn.a").last().locator(".wr")).toHaveCount(0);
});

test("a live tool step that cannot run says why while the reply streams, and the reply still ends", async ({ page, open }) => {
  await open();
  await waitReady(page);
  // Image on offers the model tools; the Library is empty, so its read fails
  await imageWithNoComfy(page);
  await page.keyboard.press("Escape");
  await waitReady(page);
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await stack.scenario("models", { tokenDelayMs: 1, firstTokenDelayMs: 0 });
  await sendMessage(page, "Use a tool to open my docs");

  // live: the failed step shows in the turn that is still streaming (a finished turn is .done)
  const step = page.locator(".turn.a:not(.done) .wr").first();
  await expect(step.locator(".wr-m")).toContainText("failed");
  await expect(step.locator(".wr-h")).toHaveText("Tool could not finish");
  // the fake model asks for the same tool every step, so the reply runs to the
  // harness's tool-turn limit; it must still end by itself
  await replyEnded(page, 30_000);
  const reply = page.locator(".turn.a").last();
  await expect(reply.locator(".wr").first().locator(".wr-h")).toHaveText("Tool could not finish");
  await reply.locator(".wr").first().click();
  await expect(reply.locator(".wr").first()).toContainText("Path is outside your Library");
});

test.fixme("Library: add a folder, then a chat reads a file in it through a live tool step and quotes it", async () => {
  // needs the fake model to call read on /library/<source id>/<file> (it always asks for ~/docs)
});

test.fixme("Image: a chat with Image on queues a picture, ComfyUI renders it, and it appears in the thread", async () => {
  // needs a fake ComfyUI, and the image module's GPU check on the fake nvidia-smi (main.ts)
});

test.fixme("Tool step: a live tool row runs, finishes with its output, and opens to show it", async () => {
  // needs a Library source the fake model's call can read (see the Library twin)
});
