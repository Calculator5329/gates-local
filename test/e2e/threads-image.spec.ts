import type { Page } from "@playwright/test";
import { fakeComfy } from "./fake-comfy.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";
import { INSTALLED, SMALL, configure, contextSize, finished, pick, release, shot, start, state } from "./threads-support.ts";

test.use({ installed: INSTALLED, video: process.env["GL_E2E_RECORD"] || process.env["GL_FLICKER_MEASURE"] ? "on" : "off", screenshot: "only-on-failure" });
let comfy: Awaited<ReturnType<typeof fakeComfy>>;
test.beforeEach(async () => { comfy = await fakeComfy(); });
test.afterEach(async () => { await comfy.close(); });

async function setup(page: Page, open: () => Promise<void>) {
  await stack.reset("threads", 0, undefined, "system", INSTALLED, comfy.url);
  await open(); await waitReady(page);
  // Two same-model slots let the image-tool request finish while alpha holds
  // its chat claim; no different-model load can preempt alpha during setup.
  await configure({ parallelLimit: 2, prompts: { alpha: { holdAfterTokens: 28 } } });
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Image generation", exact: true }).click();
  await page.getByRole("switch", { name: "Generate images" }).click();
  // the chat model makes the picture through its tool
  await page.locator(".snav").getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("switch", { name: "Make images" }).click();
  await expect(page.getByRole("switch", { name: "Make images" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
}

async function askForImage(page: Page) {
  await pick(page, "qwen3.5:9b");
  await contextSize(page, 16384);
  await sendMessage(page, "Use a tool to draw a ship");
  await expect(page.locator(".turn.u .bubble").last()).toHaveText("Use a tool to draw a ship");
  await expect.poll(async () => (await state()).turns.some((turn) => turn.prompt === "Use a tool to draw a ship")).toBe(true);
}

test("image behind chat: the card explains its wait, and rendering starts only after the reply finishes", async ({ page, open }) => {
  await setup(page, open);
  await start(page, "alpha", "qwen3.5:9b");
  await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await page.getByRole("button", { name: "New thread" }).click();
  await askForImage(page);
  const card = page.locator("[data-image-job]");
  await expect(card).toContainText("Waiting for the GPU");
  expect(comfy.state()).toHaveLength(0);
  expect((await state()).turns.find((turn) => turn.prompt === "alpha")?.endedAt).toBeUndefined();
  await shot(page, "image-waiting-for-chat");
  await release("alpha");
  await expect(card).toContainText("Making image");
  await expect.poll(() => comfy.state().length).toBe(1);
  const chat = (await state()).turns.find((turn) => turn.prompt === "alpha");
  expect(chat?.outcome).toBe("done");
  expect(comfy.state()[0]?.startedAt).toBeGreaterThanOrEqual(chat?.endedAt ?? Infinity);
  expect((await state()).turns.every((turn) => turn.endedAt !== undefined)).toBe(true);
  comfy.finish();
  await expect(card.getByRole("img", { name: "Generated image" })).toBeVisible();
  await page.locator(".sb-row", { hasText: "alpha" }).click();
  await finished(page, "alpha");
});

test("chat behind image: the reply names image generation and sends to Ollama only after rendering ends", async ({ page, open }) => {
  await setup(page, open);
  await askForImage(page);
  const card = page.locator("[data-image-job]");
  await expect(card).toContainText("Making image");
  await expect.poll(() => comfy.state().length).toBe(1);
  const before = (await state()).turns.length;
  await page.getByRole("button", { name: "New thread" }).click();
  await pick(page, SMALL[0] ?? "tiny-chat:2k");
  await sendMessage(page, "chat behind image");
  await expect(page.locator(".turn.u .bubble")).toHaveText("chat behind image");
  await expect(page.locator(".working")).toContainText("Waiting for image generation");
  expect((await state()).turns).toHaveLength(before);
  expect(comfy.state()[0]?.endedAt).toBeUndefined();
  await shot(page, "chat-waiting-for-image");
  comfy.finish();
  await finished(page, "chat behind image");
  const chat = (await state()).turns.find((turn) => turn.prompt === "chat behind image");
  expect(chat?.receivedAt).toBeGreaterThanOrEqual(comfy.state()[0]?.endedAt ?? Infinity);
  expect(chat?.outcome).toBe("done");
});
