// Journey: a model that keeps only about 2,000 tokens in view is a normal
// model. It is offered, it chats, and the app never asks it for more than it
// reports. One that reports no maximum runs at the safe fallback.
import type { Page } from "@playwright/test";
import { FAKE_URL } from "./env.ts";
import { expect, openGpuMemory, openModels, sendMessage, stack, test, waitReady } from "./fixtures.ts";

const stopButton = (page: Page) => page.getByRole("button", { name: "Stop" });

const loadedCtx = async (name: string): Promise<number | undefined> => {
  const state = (await (await fetch(`${FAKE_URL}/__fake/state`)).json()) as { loaded: { name: string; numCtx: number }[] };
  return state.loaded.find((m) => m.name === name)?.numCtx;
};

test.describe("a model with a 2,048 context window", () => {
  test.use({ installed: ["tiny-chat:2k"] });

  test("use a small model, inspect its defaults and refuse an oversized message", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await test.step("show the usable model and default fallback", async () => {
    await openModels(page);
    const row = page.locator('.mp-row[data-dm="tiny-chat:2k"]');
    await expect(row.locator(".mp-fitc")).toHaveText("Should run well");
    await expect(row).not.toHaveClass(/\bcant\b/);
    await expect(page.locator(".mp")).not.toContainText(/supports up to|too small|unsupported|won't run/i);
    // the fallback rule is the tip of "Default for new chats", not words on the row
    const defaultLabel = page.locator(".mp-defrow .tipped").filter({ hasText: "Default for new chats" });
    await expect(defaultLabel).toHaveAttribute("data-tip", /If it can't run here/);
    await expect(defaultLabel).toHaveAttribute("aria-description", /If it can't run here/);
    await expect(page.locator(".mp-defrow")).not.toContainText("16k");
    });
    await page.keyboard.press("Escape");
    await test.step("chat at 2k and offer only supported context", async () => {
    await expect(page.locator("body")).not.toContainText("Supports up to");

    await sendMessage(page, "Say hello");
    await expect(page.locator(".turn.a").last().locator(".md")).toContainText("You asked: Say hello");
    await expect(stopButton(page)).toHaveCount(0, { timeout: 10_000 });
    expect(await loadedCtx("tiny-chat:2k")).toBe(2048);

    await page.locator("#modelBtn").click();
    for (const size of [8192, 16384, 32768, 65536]) await expect(page.locator(`#picker [data-ctx="${size}"]`)).toBeDisabled();
    await expect(page.locator("#picker .pk-help")).toHaveText("Runs at 2k, the most this model takes.");
    });
    await page.keyboard.press("Escape");
    await test.step("keep the saved context default while reporting the model limit", async () => {
    const gpu = await openGpuMemory(page);
    const saved = gpu.getByRole("group", { name: "Default context" }).getByRole("button", { name: "16k" });
    await expect(saved).toHaveAttribute("aria-pressed", "true");
    await expect(saved).toBeDisabled();
    await expect(gpu.locator(".ctx-line")).toContainText("Runs at 2k, the most this model takes.");
    await expect(gpu.locator(".fp-v:visible")).toContainText("at 2k");
    });
    await page.keyboard.press("Escape");
    await test.step("explain an oversized message", async () => {
    await sendMessage(page, "word ".repeat(2000));
    await expect(page.locator(".err-line")).toContainText("too long for this model");
    });
  });
});

test.describe("a 2,048 model when a reply ends while Settings is open", () => {
  test.use({ installed: ["tiny-chat:2k"] });

  test("Settings › Advanced keeps its value when the reply ends, with no fit request and no checking state", async ({ page, open }) => {
    await stack.scenario("slow-drip", { tokenDelayMs: 1, firstTokenDelayMs: 0, installed: ["tiny-chat:2k"] });
    let release: (() => void) | undefined;
    let holding = true;
    let deliveredTerminals = 0;
    const asked: string[] = [];
    await page.routeWebSocket(/.*/, ws => {
      const server = ws.connectToServer();
      ws.onMessage(message => {
        const request = JSON.parse(String(message)) as { method?: string };
        if (request.method?.startsWith("fit.")) asked.push(request.method);
        server.send(message);
      });
      server.onMessage(message => {
        const response = JSON.parse(String(message)) as { type?: string; channel?: string; payload?: { event?: { type?: string } } };
        if (holding && response.channel === "chat.event" && response.payload?.event?.type === "done") release = () => { deliveredTerminals++; ws.send(message); };
        else ws.send(message);
      });
    });
    await open();
    await waitReady(page);
    await sendMessage(page, "Say hello");
    await expect(stopButton(page)).toBeVisible();
    const gpu = await openGpuMemory(page);
    // The terminal frame is held outside the page, so the reply is still running.
    expect(deliveredTerminals).toBe(0);
    await expect.poll(() => release !== undefined).toBe(true);
    await expect(gpu.locator(".fp-v:visible")).toContainText("at 2k");
    const before = asked.length;
    // The end of a turn makes the server rebuild the table; it pushes only when something changed.
    holding = false;
    release?.();
    await expect(stopButton(page)).toHaveCount(0, { timeout: 10_000 });
    await expect(gpu.locator(".fp-v:visible")).toContainText("at 2k");
    await expect(gpu.locator(".fit-skel")).toHaveCount(0);
    expect(asked.slice(before), "the reply's end makes no fit request").toEqual([]);
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
