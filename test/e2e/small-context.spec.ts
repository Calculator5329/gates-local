// Journey: a model that keeps only about 2,000 tokens in view is a normal
// model. It is offered, it chats, and the app never asks it for more than it
// reports. One that reports no maximum runs at the safe fallback.
import type { Page } from "@playwright/test";
import { FAKE_URL } from "./env.ts";
import { expect, openGpuMemory, sendMessage, stack, test, waitReady } from "./fixtures.ts";

const stopButton = (page: Page) => page.getByRole("button", { name: "Stop" });

const loadedCtx = async (name: string): Promise<number | undefined> => {
  const state = (await (await fetch(`${FAKE_URL}/__fake/state`)).json()) as { loaded: { name: string; numCtx: number }[] };
  return state.loaded.find((m) => m.name === name)?.numCtx;
};

test.describe("a model with a 2,048 context window", () => {
  test.use({ installed: ["tiny-chat:2k"] });

  test("chats at 2k with no refusal, and offers no size it cannot take", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await expect(page.locator("body")).not.toContainText("Supports up to");

    await sendMessage(page, "Say hello");
    await expect(page.locator(".turn.a").last().locator(".md")).toContainText("You asked: Say hello");
    await expect(stopButton(page)).toHaveCount(0, { timeout: 10_000 });
    expect(await loadedCtx("tiny-chat:2k")).toBe(2048);

    await page.locator("#modelBtn").click();
    for (const size of [8192, 16384, 32768, 65536]) await expect(page.locator(`#picker [data-ctx="${size}"]`)).toBeDisabled();
    await expect(page.locator("#picker .pk-help")).toHaveText("Runs at 2k, the most this model takes.");
  });

  test("Settings › Models lists it as a usable model, with no too-small label", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await page.keyboard.press("Control+Comma");
    await page.locator(".snav").getByRole("button", { name: "Models", exact: true }).click();
    const row = page.locator('.mp-row[data-dm="tiny-chat:2k"]');
    await expect(row.locator(".mp-fitc")).toHaveText("Should run well");
    await expect(row).not.toHaveClass(/\bcant\b/);
    await expect(page.locator(".mp")).not.toContainText(/supports up to|too small|unsupported|won't run/i);
    await expect(page.locator(".mp-defrow")).toContainText("If it can't run here");
    await expect(page.locator(".mp-defrow")).not.toContainText("16k");
  });

  test("says in plain words when a message is too long for it", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await sendMessage(page, "word ".repeat(2000));
    await expect(page.locator(".err-line")).toContainText("too long for this model");
  });

  test("Settings › Advanced keeps the saved default selected and says what this model runs at", async ({ page, open }) => {
    await open();
    await waitReady(page);
    const gpu = await openGpuMemory(page);
    const saved = gpu.getByRole("group", { name: "Default context" }).getByRole("button", { name: "16k" });
    await expect(saved).toHaveAttribute("aria-pressed", "true");
    await expect(saved).toBeDisabled();
    await expect(gpu.locator(".ctx-line")).toContainText("Runs at 2k, the most this model takes.");
    await expect(gpu.locator(".fp-v:visible")).toContainText("at 2k");
  });
});

test.describe("a 2,048 model when a reply ends while Settings is open", () => {
  test.use({ installed: ["tiny-chat:2k"] });

  test("Settings › Advanced gets its answer again rather than checking forever", async ({ page, open }) => {
    // about 10 s of reply, so Settings is open well before it ends even on a busy machine
    await stack.scenario("slow-drip", { tokenDelayMs: 100, firstTokenDelayMs: 0, installed: ["tiny-chat:2k"] });
    let ended = false;
    const replyEnded = new Promise<void>((resolve) => {
      page.on("websocket", (ws) => {
        ws.on("framereceived", (frame) => {
          if (typeof frame.payload === "string" && frame.payload.includes('"done"')) {
            ended = true;
            resolve();
          }
        });
      });
    });
    await open();
    await waitReady(page);
    await sendMessage(page, "Say hello");
    await expect(stopButton(page)).toBeVisible();
    const gpu = await openGpuMemory(page);
    expect(ended, "the reply must still be running when Settings opens").toBe(false);
    // the end of a reply clears every saved memory answer, and the chat box that would ask again is not on this screen
    await replyEnded;
    // nothing on this screen marks the push being handled; a slow one can only let the old code pass, never fail the new code
    await page.waitForTimeout(500);
    await expect(gpu.locator(".fp-v:visible")).toContainText("at 2k");
    await expect(gpu).not.toContainText("Checking");
  });
});

test.describe("a model that reports no maximum", () => {
  test.use({ installed: ["no-limit-chat:1b"] });

  test("chats at the safe fallback", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await sendMessage(page, "Say hello");
    await expect(page.locator(".turn.a").last().locator(".md")).toContainText("You asked: Say hello");
    await expect(stopButton(page)).toHaveCount(0, { timeout: 10_000 });
    expect(await loadedCtx("no-limit-chat:1b")).toBe(4096);
    await page.locator("#modelBtn").click();
    await expect(page.locator("#picker .pk-help")).toHaveText("Runs at 4k, the most this model takes.");
  });
});
