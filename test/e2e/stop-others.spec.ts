// The warning before a send stops another chat's reply, against the fake
// Ollama. The first chat runs a model that leaves no room for the second, so
// the real planner says stopping it is the only way, and the real server does
// the stopping: every assertion here is what the person would see.
import { type Page } from "@playwright/test";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

const SHOTS = process.env["GL_SHOTS_DIR"];

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function pickModel(page: Page, search: string, tag: string): Promise<void> {
  await page.locator("#modelBtn").click();
  await page.locator("#pkSearch").fill(search);
  await page.locator(`#picker .pk-r[data-m="${tag}"]`).click();
  await expect(page.locator("#picker")).toBeHidden();
}

/** A reply on the 12B model at 32k that keeps streaming until it is stopped. */
async function firstChatAnswering(page: Page): Promise<void> {
  await stack.scenario("slow-drip", { holdAfterTokens: 46 });
  await pickModel(page, "gemma", "gemma4:12b");
  await sendMessage(page, "How do I check disk space before a download?");
  await expect(page.locator(".turn.a .md ul li")).toHaveCount(3, { timeout: 15_000 });
}

/** The second chat, on the model whose load must stop the first. */
async function secondChatReady(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New thread" }).click();
  await pickModel(page, "qwen", "qwen3.5:9b");
  await page.locator("#ta").fill("A question for the other model");
}

const warning = (page: Page) => page.getByRole("alertdialog", { name: "Stop the other reply?" });

test("sending on a model that needs the memory warns, then stops the other chat, which keeps its words", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await firstChatAnswering(page);
  await secondChatReady(page);
  await shot(page, "01-before-send");

  await page.locator("#ta").press("Enter");
  await expect(warning(page)).toContainText("This stops Gemma 4 12B in “How do I check disk space before a download?”. Its reply so far is kept.");
  await shot(page, "02-warning");

  await warning(page).getByRole("button", { name: "Cancel" }).click();
  await expect(warning(page)).toBeHidden();
  await expect(page.locator("#ta")).toHaveValue("A question for the other model");

  await page.locator("#ta").press("Enter");
  await warning(page).getByRole("button", { name: "Stop and send" }).click();
  await expect(page.locator(".turn.u").last()).toContainText("A question for the other model");
  await expect(page.locator("#ta")).toHaveValue("");

  // the chat that stopped: its words and one sentence
  await page.locator(".sb-row", { hasText: "How do I check disk space" }).click();
  await expect(page.locator(".stop-note")).toHaveText("Stopped so Qwen 3.5 9B could load.");
  await expect(page.locator(".turn.a.done .md ul li")).toHaveCount(3);
  await expect(page.locator(".turn.a .writing")).toHaveCount(0);
  await shot(page, "03-stopped-chat");
});

test("'Don't show this again' survives a reload and later sends stop the other chat with no prompt", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await firstChatAnswering(page);
  await secondChatReady(page);
  await page.locator("#ta").press("Enter");
  await warning(page).getByLabel("Don't show this again").check();
  await shot(page, "04-dont-show-again");
  await warning(page).getByRole("button", { name: "Stop and send" }).click();
  await expect(page.locator(".turn.u").last()).toContainText("A question for the other model");
  // the fake holds this reply too; nothing is running across the reload
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);

  await page.reload();
  await waitReady(page);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("gates-local.stop-others-ok"))).toBe("1");

  await page.getByRole("button", { name: "New thread" }).click();
  await firstChatAnswering(page);
  await secondChatReady(page);
  await page.locator("#ta").press("Enter");
  await expect(page.locator(".turn.u").last()).toContainText("A question for the other model");
  await expect(warning(page)).toHaveCount(0);
  await page.locator(".sb-row", { hasText: "How do I check disk space" }).first().click();
  await expect(page.locator(".stop-note")).toHaveText("Stopped so Qwen 3.5 9B could load.");
});
