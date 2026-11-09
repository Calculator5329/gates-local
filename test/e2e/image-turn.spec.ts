import type { Page } from "@playwright/test";
import { createClient } from "@gates-local/contracts";
import { fakeComfy } from "./fake-comfy.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

test.use({ video: "on", allowedErrors: [/WebSocket connection to .* failed/] });
let comfy: Awaited<ReturnType<typeof fakeComfy>>;
test.beforeEach(async () => { comfy = await fakeComfy(); });
test.afterEach(async () => { await comfy.close(); });

async function setup(page: Page, open: () => Promise<void>) {
  await stack.reset("image-turn", 0, undefined, "system", undefined, comfy.url);
  await open(); await waitReady(page);
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Image generation", exact: true }).click();
  await page.getByRole("switch", { name: "Generate images" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await sendMessage(page, "Generate an image of a Star Trek ship");
}

test("an image tool answers with a durable job card, never the invented follow-up URL", async ({ page, open }, info) => {
  const remote: string[] = [];
  page.on("request", req => { if (req.url().includes("example.com")) remote.push(req.url()); });
  await setup(page, open);
  const card = page.locator("[data-image-job]");
  await expect(card).toContainText("Making image");
  await expect(page.locator(".tl")).not.toContainText("Here's an image");
  await expect(page.locator(".tl")).not.toContainText("0 ms");
  const before = await card.boundingBox();
  await page.reload(); await waitReady(page);
  await expect(card).toContainText("Making image");
  await page.screenshot({ path: info.outputPath("making.png"), animations: "disabled" });
  comfy.finish();
  await expect(card.getByRole("img", { name: "Generated image" })).toBeVisible();
  await expect.poll(() => card.getByRole("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  const after = await card.boundingBox();
  expect(after?.height).toBe(before?.height);
  expect(remote).toEqual([]);
  await page.reload(); await waitReady(page);
  await expect(card.getByRole("img", { name: "Generated image" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("done.png"), animations: "disabled" });
});

test("a failed image has one retry across clients and its button follows the outcome", async ({ page, open, context }, info) => {
  comfy.missing();
  await setup(page, open);
  const card = page.locator("[data-image-job]");
  await expect(card).toContainText("Install the image checkpoint and LoRA");
  await page.reload(); await waitReady(page);
  await expect(card).toContainText("Install the image checkpoint and LoRA");
  await page.screenshot({ path: info.outputPath("failed.png"), animations: "disabled" });
  comfy.restore(false);
  await card.getByRole("button", { name: "Try again" }).click();
  const original = card.first();
  await expect(original.getByRole("button", { name: /Retry queued|Retrying/ })).toBeDisabled();
  const server = new URL(page.url()).searchParams.get("server");
  const threadId = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("thread");
  if (!server || !threadId) throw new Error("No test server or thread");
  const other = await context.newPage();
  const client = createClient(new WebSocket(server));
  try {
    await other.goto(page.url()); await waitReady(other);
    await expect(other.locator("[data-image-job]").first().getByRole("button", { name: /Retry queued|Retrying/ })).toBeDisabled();
    const snapshot = await client.call("threads.get", { threadId });
    const failed = snapshot.messages.find(m => m.imageJob?.retryJobId !== undefined)?.imageJob;
    if (!failed?.retryJobId) throw new Error("No accepted retry link");
    expect(await client.call("image.generate", { threadId, prompt: "ignored duplicate", retryOf: failed.jobId })).toEqual({ jobId: failed.retryJobId });
    await expect(card).toHaveCount(2);
    expect((await client.call("threads.get", { threadId })).messages.filter(m => m.imageJob !== undefined)).toHaveLength(2);
    comfy.finish();
    await expect(original.getByRole("button", { name: "Image ready" })).toBeDisabled();
    await expect(page.getByRole("img", { name: "Generated image" })).toBeVisible();
  } finally { client.close(); await other.close(); }
});

test("a restart cannot strand an unfinished image", async ({ page, open }) => {
  await setup(page, open);
  const card = page.locator("[data-image-job]");
  await expect(card).toContainText("Making image");
  await stack.restart();
  await expect(card).toContainText(/cancelled|restarted/);
  await expect(card.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("a waiting card survives a reload and cancellation leaves a reason", async ({ page, open }, info) => {
  await stack.reset("models", 0, undefined, "system", undefined, comfy.url);
  await open(); await waitReady(page);
  const server = new URL(page.url()).searchParams.get("server");
  if (!server) throw new Error("No test server URL");
  const client = createClient(new WebSocket(server));
  let turnId: string | undefined;
  try {
    await client.call("settings.update", { imageGen: true });
    const thread = await client.call("threads.create", {});
    await stack.scenario("slow-first-token", { firstTokenDelayMs: 60_000, tokenDelayMs: 0 });
    ({ turnId } = await client.call("chat.send", { threadId: thread.id, content: "Hold the chat GPU claim", model: "qwen3.5:9b", numCtx: 16384 }));
    await open(`#thread=${thread.id}`);
    await client.call("image.generate", { threadId: thread.id, prompt: "a ship" });
    const card = page.locator("[data-image-job]");
    await expect(card).toContainText("Waiting for the GPU");
    await page.reload(); await waitReady(page);
    await expect(card).toContainText("Waiting for the GPU");
    await page.screenshot({ path: info.outputPath("waiting.png"), animations: "disabled" });
    await card.getByRole("button", { name: "Cancel image" }).click();
    await expect(card).toContainText("The image was cancelled");
    await expect(card.getByRole("button", { name: "Try again" })).toBeVisible();
    await page.screenshot({ path: info.outputPath("cancelled.png"), animations: "disabled" });
  } finally {
    if (turnId) await client.call("chat.cancel", { turnId });
    client.close();
  }
});
