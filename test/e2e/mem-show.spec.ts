// Pictures for two owner rulings (2026-11-13), taken the same way on any version of the app: the
// model button of a new chat starts on the chat model in memory, and the thread says where the
// model changed mid-chat (chat to chat, chat to image). The rules are guarded by unit tests
// (apps/web/src/session-models.test.ts, apps/web/src/model-change.test.ts); this only shoots.
import type { Page } from "@playwright/test";
import { createClient } from "@gates-local/contracts";
import { fakeComfy } from "./fake-comfy.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

test.use({ viewport: { width: 1920, height: 1080 }, allowedErrors: [/WebSocket connection to .* failed/] });

const INSTALLED = ["qwen3.5:9b", "gemma4:12b"] as const;
const NAMES: Record<string, string> = { "qwen3.5:9b": "Qwen 3.5 9B", "gemma4:12b": "Gemma 4 12B" };

let comfy: Awaited<ReturnType<typeof fakeComfy>>;
// a GPU: on the CPU a job with nothing picked needs an encoder Klein's files lack
test.beforeEach(async () => { comfy = await fakeComfy(); comfy.gpu(); });
test.afterEach(async () => { await comfy.close(); });

/** The installed model the button shows. */
async function onButton(page: Page): Promise<string> {
  const text = (await page.locator("#modelBtn").textContent()) ?? "";
  const tag = INSTALLED.find((t) => text.includes(NAMES[t]!));
  if (tag === undefined) throw new Error(`the button shows neither model: ${text}`);
  return tag;
}

const otherThan = (tag: string): string => INSTALLED.find((t) => t !== tag)!;

async function pick(page: Page, tag: string): Promise<void> {
  await page.locator("#modelBtn").click();
  await page.locator(`#picker .pk-r[data-m="${tag}"] .pk-select`).click();
  await expect(page.locator("#picker")).toBeHidden();
}

async function replies(page: Page, n: number): Promise<void> {
  await expect(page.locator(".turn.a")).toHaveCount(n, { timeout: 15_000 });
  // the fake's reply ends with these words: a turn waiting for its model has none
  await expect(page.locator(".turn.a").last()).toContainText("streaming takes", { timeout: 15_000 });
  await expect(page.locator(".think.run")).toHaveCount(0, { timeout: 15_000 });
}

test("the model button on a new chat with another model in memory, and a thread whose model changes twice", async ({ page, open }, info) => {
  await stack.reset("models", 0, undefined, "system", [...INSTALLED], comfy.url);
  await open(); await waitReady(page);
  const stored = await onButton(page);
  const server = new URL(page.url()).searchParams.get("server");
  if (!server) throw new Error("No test server URL");
  const client = createClient(new WebSocket(server));
  try {
    await client.call("settings.update", { imageGen: true });
    // the model that is not the stored default goes into memory, as another chat's send would put it
    const load = await client.call("models.load", { model: otherThan(stored), numCtx: 16384 });
    expect(load.state).toBe("ready");
  } finally { client.close(); }

  // a new chat opened now
  await page.reload(); await waitReady(page);
  await page.mouse.move(5, 5);
  await page.screenshot({ path: info.outputPath("button.png"), animations: "disabled" });

  const first = await onButton(page);
  await sendMessage(page, "What is a context window?");
  await replies(page, 1);
  await pick(page, otherThan(first));
  await sendMessage(page, "Say it in one line.");
  await replies(page, 2);
  // the chat-to-chat change, before the image card fills the view
  await page.mouse.move(5, 5);
  await page.screenshot({ path: info.outputPath("thread-chat.png"), animations: "disabled" });
  await page.getByTestId("chat.composer.image").click();
  await sendMessage(page, "A lighthouse at dusk");
  const card = page.locator("[data-image-job]");
  await expect(card.getByRole("status", { name: /Making image/ })).toBeVisible({ timeout: 15_000 });
  comfy.finish();
  await expect(card.getByRole("img", { name: "Generated image" })).toBeVisible();
  await expect.poll(() => card.getByRole("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await page.mouse.move(5, 5);
  await page.screenshot({ path: info.outputPath("thread-image.png"), animations: "disabled" });
});
