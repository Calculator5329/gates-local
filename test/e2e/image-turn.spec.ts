import type { Page } from "@playwright/test";
import { createClient } from "@gates-local/contracts";
import { fakeComfy } from "./fake-comfy.ts";
import { FAKE_URL } from "./env.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

test.use({ video: process.env["GL_E2E_RECORD"] || process.env["GL_FLICKER_MEASURE"] ? "on" : "off", allowedErrors: [/WebSocket connection to .* failed/] });
let comfy: Awaited<ReturnType<typeof fakeComfy>>;
// a GPU: a send with nothing picked has no default on the CPU
test.beforeEach(async () => { comfy = await fakeComfy(); comfy.gpu(); });
test.afterEach(async () => { await comfy.close(); });

/**
 * Image generation on, then one ask for a picture: `image` sends it with the composer's Image
 * button (straight to the image model), `tool` turns on Settings › Tools › Make images and lets
 * the chat model call the image tool.
 */
async function setup(page: Page, open: () => Promise<void>, via: "image" | "tool" = "image") {
  await stack.reset("image-turn", 0, undefined, "system", undefined, comfy.url);
  await open(); await waitReady(page);
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Image generation", exact: true }).click();
  await page.getByRole("switch", { name: "Generate images" }).click();
  if (via === "tool") {
    await page.locator(".snav").getByRole("button", { name: "Tools", exact: true }).click();
    // on once a setup can run, with no click
    const make = page.getByRole("switch", { name: "Make images" });
    await expect(make).toBeEnabled();
    await expect(make).toHaveAttribute("aria-checked", "true");
  }
  await page.keyboard.press("Escape");
  if (via === "image") await page.getByRole("button", { name: "Image", exact: true }).click();
  await sendMessage(page, "Generate an image of a Star Trek ship");
}

test("the chat model's image tool answers with a durable job card, never the invented follow-up URL", async ({ page, open }, info) => {
  const remote: string[] = [];
  page.on("request", req => { if (req.url().includes("example.com")) remote.push(req.url()); });
  await setup(page, open, "tool");
  const card = page.locator("[data-image-job]");
  await expect(card.getByRole("status", { name: /Making image/ })).toBeVisible();
  // the chat model's tool started it, so no Stop covers it: the card keeps its own Cancel
  await expect(card.getByRole("button", { name: "Cancel image" })).toBeVisible();
  await expect(page.locator(".tl")).not.toContainText("Here's an image");
  // no zero-length step; a real one may last 20 ms
  await expect(page.locator(".tl")).not.toContainText(/\b0 ms/);
  const before = await card.boundingBox();
  await page.reload(); await waitReady(page);
  await expect(card.getByRole("status", { name: /Making image/ })).toBeVisible();
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

// no preset has every file: the card names the first default's file
const MISSING = "Install flux-2-klein-4b-fp8.safetensors in ComfyUI, then try again.";

test("a retry takes over the failed card's box across clients and reloads, and one request stays one retry", async ({ page, open, context }, info) => {
  comfy.missing();
  await setup(page, open);
  const card = page.locator("[data-image-job]");
  await expect(card).toContainText(MISSING);
  await page.reload(); await waitReady(page);
  await expect(card).toContainText(MISSING);
  const box = await card.boundingBox();
  await page.screenshot({ path: info.outputPath("failed.png"), animations: "disabled" });
  comfy.restore(false);
  await card.getByRole("button", { name: "Try again" }).click();
  // the one box now says what the retry is doing; the old reason is gone
  await expect(card).toHaveCount(1);
  await expect(card.getByRole("status", { name: /Waiting for the GPU|Making image/ })).toBeVisible();
  await expect(card).not.toContainText(MISSING);
  expect(await card.boundingBox()).toEqual(box);
  await page.reload(); await waitReady(page);
  await expect(card).toHaveCount(1);
  await expect(card.getByRole("status", { name: /Waiting for the GPU|Making image/ })).toBeVisible();
  expect(await card.boundingBox()).toEqual(box);
  const server = new URL(page.url()).searchParams.get("server");
  const threadId = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("thread");
  if (!server || !threadId) throw new Error("No test server or thread");
  const other = await context.newPage();
  const client = createClient(new WebSocket(server));
  try {
    await other.goto(page.url()); await waitReady(other);
    await expect(other.locator("[data-image-job]")).toHaveCount(1);
    await expect(other.locator("[data-image-job]").getByRole("status", { name: /Waiting for the GPU|Making image/ })).toBeVisible();
    const snapshot = await client.call("threads.get", { threadId });
    const failed = snapshot.messages.find(m => m.imageJob?.retryJobId !== undefined)?.imageJob;
    if (!failed?.retryJobId) throw new Error("No accepted retry link");
    expect(await client.call("image.generate", { threadId, prompt: "ignored duplicate", retryOf: failed.jobId })).toEqual({ jobId: failed.retryJobId });
    // the thread keeps both attempts as card messages; the page shows one box
    expect((await client.call("threads.get", { threadId })).messages.filter(m => m.imageJob !== undefined)).toHaveLength(2);
    await expect(card).toHaveCount(1);
    comfy.finish();
    await expect(card.getByRole("img", { name: "Generated image" })).toBeVisible();
    await expect(card).toHaveCount(1);
    await expect(page.locator(".tl")).not.toContainText(MISSING);
    await expect(page.locator(".tl")).not.toContainText("Image ready");
    expect(await card.boundingBox()).toEqual(box);
    await page.reload(); await waitReady(page);
    await expect(card).toHaveCount(1);
    await expect(card.getByRole("img", { name: "Generated image" })).toBeVisible();
    expect(await card.boundingBox()).toEqual(box);
    await page.screenshot({ path: info.outputPath("retried.png"), animations: "disabled" });
  } finally { client.close(); await other.close(); }
});

test("a retry that fails shows its own reason and Try again in the same box, after a reload too", async ({ page, open }) => {
  comfy.missing();
  await setup(page, open);
  const card = page.locator("[data-image-job]");
  await expect(card).toContainText(MISSING);
  const box = await card.boundingBox();
  const firstJob = await card.getAttribute("data-job");
  await card.getByRole("button", { name: "Try again" }).click();
  // the retry fails the same way: one box, one reason, Try again again
  await expect(card).not.toHaveAttribute("data-job", firstJob ?? "");
  await expect(card).toHaveAttribute("data-image-job", "error");
  await expect(card).toHaveCount(1);
  await expect(card.getByRole("button", { name: "Try again" })).toBeEnabled();
  await expect(card.getByText(MISSING)).toHaveCount(1);
  expect(await card.boundingBox()).toEqual(box);
  await page.reload(); await waitReady(page);
  await expect(card).toHaveCount(1);
  await expect(card.getByText(MISSING)).toHaveCount(1);
  await expect(card.getByRole("button", { name: "Try again" })).toBeEnabled();
  expect(await card.boundingBox()).toEqual(box);
  comfy.restore();
  await card.getByRole("button", { name: "Try again" }).click();
  await expect(card.getByRole("img", { name: "Generated image" })).toBeVisible();
  await expect(card).toHaveCount(1);
});

test("a restart cannot strand an unfinished image", async ({ page, open }, info) => {
  await setup(page, open);
  const card = page.locator("[data-image-job]");
  await expect(card.getByRole("status", { name: /Making image/ })).toBeVisible();
  // an Image turn's card: the composer's Stop cancels it, so the card has no Cancel; the model and
  // size wait for the result; beside the spinner only numbers, the seconds since the ask
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Cancel image" })).toHaveCount(0);
  await expect(card.locator(".image-job-model")).toHaveCount(0);
  await expect(card.locator(".image-job-state p")).toHaveText(/^(\d+% · )?\d+ s$/);
  await page.screenshot({ path: info.outputPath("image-turn-running.png"), animations: "disabled" });
  await stack.restart();
  await expect(card).toContainText(/cancelled|restarted/);
  await expect(card.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(card.locator(".image-job-model")).toBeVisible();
});

/** The models the fake Ollama holds in memory now. */
const loaded = async () => ((await (await fetch(`${FAKE_URL}/__fake/state`)).json()) as { loaded: { name: string }[] }).loaded.map((l) => l.name);
const replies = async (client: ReturnType<typeof createClient>, threadId: string, count: number) =>
  expect.poll(async () => (await client.call("threads.get", { threadId })).messages.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(count);

test("after a restart, one chat turn on the model that stayed loaded lets the next image unload it", async ({ page, open }, info) => {
  const connect = () => {
    const server = new URL(page.url()).searchParams.get("server");
    if (!server) throw new Error("No test server URL");
    return createClient(new WebSocket(server));
  };
  await stack.reset("models", 0, undefined, "system", undefined, comfy.url);
  await open(); await waitReady(page);
  const first = connect();
  let threadId: string;
  try {
    await first.call("settings.update", { imageGen: true });
    threadId = (await first.call("threads.create", {})).id;
    await first.call("chat.send", { threadId, content: "hello", model: "qwen3.5:9b", numCtx: 16384 });
    await replies(first, threadId, 2);
  } finally { first.close(); }
  // The app restarts; the chat model stays in Ollama, which the new process never loaded.
  await stack.restart();
  await open(`#thread=${threadId}`); await waitReady(page);
  expect(await loaded()).toContain("qwen3.5:9b");
  const again = connect();
  try {
    await again.call("chat.send", { threadId, content: "and again", model: "qwen3.5:9b", numCtx: 16384 });
    await replies(again, threadId, 4);
    // Before Send the picker says what the server will do: the model the turn ran on is freed, not Too big.
    await page.getByRole("button", { name: "Image", exact: true }).click();
    await page.locator("#modelBtn").click();
    const sizes = page.locator("#imagePicker .pk-context");
    await expect(sizes.locator(".pk-cost.spill").first(), "the size row marks that it stops the chat model").toBeVisible();
    await expect(sizes.locator(".pk-cost.no"), "no size row says Too big for an image the server will make").toHaveCount(0);
    await page.keyboard.press("Escape");
    comfy.gpu();
    await again.call("image.generate", { threadId, prompt: "a sci fi background" });
    const card = page.locator("[data-image-job]");
    await expect(card.getByRole("status", { name: /Making image/ })).toBeVisible();
    await expect(card).not.toHaveAttribute("data-fit", "refuse");
    // the card is running as the job starts, before its fit frees memory: wait for the unload
    await expect.poll(loaded, { message: "the image unloaded the model the turn ran on", timeout: 15_000 }).not.toContain("qwen3.5:9b");
    comfy.finish();
    await expect(card.getByRole("img", { name: "Generated image" })).toBeVisible();
    await page.screenshot({ path: info.outputPath("warm-swap-done.png"), animations: "disabled" });
  } finally { again.close(); }
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
