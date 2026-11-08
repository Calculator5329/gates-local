// Journey: a model that keeps only about 2,000 tokens in view is a normal
// model. It is offered, it chats, and the app never asks it for more than it
// reports. One that reports no maximum runs at the safe fallback.
import { FAKE_URL } from "./env.ts";
import { expect, sendMessage, test, waitReady } from "./fixtures.ts";

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
    await expect(page.locator(".caret")).toHaveCount(0, { timeout: 10_000 });
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
    await expect(row.locator(".mp-fitc")).toHaveText("Runs well");
    await expect(row).not.toHaveClass(/\bcant\b/);
    await expect(page.locator(".mp")).not.toContainText(/supports up to|too small|unsupported|won't run/i);
    await expect(page.locator(".mp-defrow")).toContainText("If it can't run at 2k");
  });

  test("says in plain words when a message is too long for it", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await sendMessage(page, "word ".repeat(2000));
    await expect(page.locator(".err-line")).toContainText("too long for this model");
  });
});

test.describe("a model that reports no maximum", () => {
  test.use({ installed: ["no-limit-chat:1b"] });

  test("chats at the safe fallback", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await sendMessage(page, "Say hello");
    await expect(page.locator(".turn.a").last().locator(".md")).toContainText("You asked: Say hello");
    await expect(page.locator(".caret")).toHaveCount(0, { timeout: 10_000 });
    expect(await loadedCtx("no-limit-chat:1b")).toBe(4096);
    await page.locator("#modelBtn").click();
    await expect(page.locator("#picker .pk-help")).toHaveText("Runs at 4k, the most this model takes.");
  });
});
