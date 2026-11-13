// The image card in each state it can show, for before and after shots at one
// crop: waiting for the GPU, making with a percent, refused for memory, done,
// and a failed card that was retried. Jobs start with image.generate, so the
// same steps make the same card on any version of the app.
import type { Page } from "@playwright/test";
import { createClient } from "@gates-local/contracts";
import { fakeComfy } from "./fake-comfy.ts";
import { expect, stack, test, waitReady } from "./fixtures.ts";

test.use({ allowedErrors: [/WebSocket connection to .* failed/] });
let comfy: Awaited<ReturnType<typeof fakeComfy>>;
// a GPU: a job with nothing picked has no default on the CPU
test.beforeEach(async () => { comfy = await fakeComfy(); comfy.gpu(); });
test.afterEach(async () => { await comfy.close(); });

type Client = ReturnType<typeof createClient>;

async function start(page: Page, open: (hash?: string) => Promise<void>): Promise<{ client: Client; threadId: string }> {
  await stack.reset("models", 0, undefined, "system", undefined, comfy.url);
  await open(); await waitReady(page);
  const server = new URL(page.url()).searchParams.get("server");
  if (!server) throw new Error("No test server URL");
  const client = createClient(new WebSocket(server));
  await client.call("settings.update", { imageGen: true });
  const thread = await client.call("threads.create", {});
  return { client, threadId: thread.id };
}

/** The card, its changed part outlined in amber, with 16 px around it. */
async function shot(page: Page, name: string, path: (name: string) => string, toBottom = false, scope = "[data-image-job]") {
  await page.mouse.move(5, 5);
  const targets = page.locator(scope);
  await targets.first().scrollIntoViewIfNeeded();
  await targets.evaluateAll((els) => { for (const el of els) { (el as HTMLElement).style.outline = "2px solid #f59e0b"; (el as HTMLElement).style.outlineOffset = "4px"; } });
  const first = await targets.first().boundingBox();
  const last = await targets.last().boundingBox();
  if (!first || !last) throw new Error(`no ${scope}`);
  const y = Math.max(0, first.y - 16);
  await page.screenshot({ path: path(name), animations: "disabled", clip: { x: Math.max(0, first.x - 16), y, width: first.width + 32, height: toBottom ? 900 - y : Math.min(900 - y, last.y + last.height + 16 - y) } });
  await targets.evaluateAll((els) => { for (const el of els) { (el as HTMLElement).style.outline = ""; (el as HTMLElement).style.outlineOffset = ""; } });
}

test("image card: waiting, making, done", async ({ page, open }, info) => {
  const { client, threadId } = await start(page, open);
  let turnId: string | undefined;
  try {
    comfy.gpu();
    // another thread's chat holds the GPU
    const other = await client.call("threads.create", {});
    await stack.scenario("slow-first-token", { firstTokenDelayMs: 60_000, tokenDelayMs: 0 });
    ({ turnId } = await client.call("chat.send", { threadId: other.id, content: "Hold the chat GPU claim", model: "qwen3.5:9b", numCtx: 16384 }));
    await open(`#thread=${threadId}`); await waitReady(page);
    await client.call("image.generate", { threadId, prompt: "a sci fi background" });
    const card = page.locator("[data-image-job]");
    await expect(card).toContainText("Waiting for the GPU");
    await shot(page, "image-card-waiting.png", n => info.outputPath(n));
    await client.call("chat.cancel", { turnId }); turnId = undefined;
    await expect(card).toContainText("Making image");
    // the server's socket to ComfyUI may open after the prompt: send until the card shows it
    await expect.poll(async () => {
      try { comfy.progress(2, 5); } catch { /* no prompt yet */ }
      return await card.textContent();
    }).toContain("40%");
    await shot(page, "image-card-making.png", n => info.outputPath(n));
    comfy.finish();
    await expect(card.getByRole("img", { name: "Generated image" })).toBeVisible();
    await shot(page, "image-card-done.png", n => info.outputPath(n));
  } finally {
    if (turnId) await client.call("chat.cancel", { turnId });
    client.close();
  }
});

test("image card: refused for memory a chat model holds", async ({ page, open }, info) => {
  const { client, threadId } = await start(page, open);
  try {
    // a chat model is resident, and after a restart this app did not load it
    await client.call("chat.send", { threadId, content: "hello", model: "qwen3.5:9b", numCtx: 16384 });
    await expect.poll(async () => (await client.call("threads.get", { threadId })).messages.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  } finally { client.close(); }
  await stack.restart();
  await open(`#thread=${threadId}`); await waitReady(page);
  const server = new URL(page.url()).searchParams.get("server");
  if (!server) throw new Error("No test server URL");
  const again = createClient(new WebSocket(server));
  try {
    comfy.gpu();
    await again.call("image.generate", { threadId, prompt: "a sci fi background" });
    const card = page.locator("[data-image-job]");
    await expect(card).toHaveAttribute("data-fit", "refuse");
    await shot(page, "image-card-refused.png", n => info.outputPath(n));
  } finally { again.close(); }
});

test("image card: a failed card retried", async ({ page, open }, info) => {
  const { client, threadId } = await start(page, open);
  try {
    comfy.missing();
    await open(`#thread=${threadId}`); await waitReady(page);
    await client.call("image.generate", { threadId, prompt: "a sci fi background" });
    const card = page.locator("[data-image-job]");
    await expect(card.first()).toHaveAttribute("data-image-job", "error");
    comfy.restore();
    await card.first().getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("img", { name: "Generated image" })).toBeVisible();
    // to the bottom of the view, so one box and two are shot at the same crop
    await shot(page, "image-card-retry.png", n => info.outputPath(n), true);
  } finally { client.close(); }
});
