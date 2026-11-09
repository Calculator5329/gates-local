// The warning before a send stops another chat's reply, against the fake
// Ollama. The first chat runs a model that leaves no room for the second, so
// the real planner says stopping it is the only way, and the real server does
// the stopping: every assertion here is what the person would see.
import { type Page } from "@playwright/test";
import { decodeRequest, type Params } from "@gates-local/contracts";
import type { FakeOllama } from "../fake-ollama/fake-ollama.ts";
import { FAKE_URL } from "./env.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

const SHOTS = process.env["GL_SHOTS_DIR"];
test.use({ video: process.env["GL_E2E_RECORD"] || process.env["GL_FLICKER_MEASURE"] ? "on" : "off", screenshot: "only-on-failure" });

async function shot(page: Page, name: string): Promise<void> {
  const repeat = test.info().repeatEachIndex;
  if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/${name}${repeat === 0 ? "" : `-r${repeat}`}.png` });
}

async function pickModel(page: Page, search: string, tag: string): Promise<void> {
  await page.locator("#modelBtn").click();
  await page.locator("#pkSearch").fill(search);
  await page.locator(`#picker .pk-r[data-m="${tag}"]`).click();
  await expect(page.locator("#picker")).toBeHidden();
}

async function runtimeState(): Promise<ReturnType<FakeOllama["state"]>> {
  const response = await fetch(`${FAKE_URL}/__fake/state`);
  expect(response.ok).toBe(true);
  return response.json() as Promise<ReturnType<FakeOllama["state"]>>;
}

/** A reply on the 12B model that keeps streaming until it is stopped. */
async function firstChatAnswering(page: Page): Promise<string> {
  await stack.scenario("slow-drip", { holdAfterTokens: 46 });
  await pickModel(page, "gemma", "gemma4:12b");
  await sendMessage(page, "How do I check disk space before a download?");
  await expect(page.locator(".turn.a .md ul li")).toHaveCount(3, { timeout: 15_000 });
  const threadId = await page.locator(".sb-row.on").getAttribute("data-thread");
  expect(threadId).not.toBeNull();
  return threadId ?? "";
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
  const victim = await firstChatAnswering(page);
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
  await page.locator(`.sb-row[data-thread="${victim}"]`).click();
  await expect(page.locator(".stop-note")).toHaveText("Stopped so Qwen 3.5 9B could load. Its text is kept here and excluded from later model prompts.");
  await expect(page.locator(".turn.a.interrupted .md ul li")).toHaveCount(3);
  await expect(page.locator(".turn.a .writing")).toHaveCount(0);
  await shot(page, "03-stopped-chat");
});

test("'Don't show this again' survives a reload and later sends stop the other chat with no prompt", async ({ page, open }) => {
  const sends: Params<"chat.send">[] = [];
  page.on("websocket", (socket) => socket.on("framesent", (frame) => {
    const request = decodeRequest(frame.payload);
    if (request.ok && request.value.method === "chat.send") sends.push(request.value.params);
  }));
  await open();
  await waitReady(page);
  await firstChatAnswering(page);
  await secondChatReady(page);
  await page.locator("#ta").press("Enter");
  await warning(page).getByLabel("Don't show this again").check();
  await shot(page, "04-dont-show-again");
  await warning(page).getByRole("button", { name: "Stop and send" }).click();
  await expect(page.locator(".turn.u").last()).toContainText("A question for the other model");
  await expect(page.locator(".turn.a .writing")).toBeVisible();
  // Stop hides immediately, even before chat.send returns its turn id.
  // Regenerate appears only after the server has ended that turn and saved its words.
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Regenerate", exact: true })).toBeEnabled();
  await expect.poll(async () => (await runtimeState()).turns.every((turn) => turn.endedAt !== undefined)).toBe(true);

  await page.reload();
  await waitReady(page);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("gates-local.stop-others-ok"))).toBe("1");

  await page.getByRole("button", { name: "New thread" }).click();
  const victim = await firstChatAnswering(page);
  const before = await runtimeState();
  expect(before.loaded.map((model) => model.name)).toEqual(["gemma4:12b"]);
  const running = before.turns.findLast((turn) => turn.model === "gemma4:12b");
  expect(running?.endedAt).toBeUndefined();
  expect(running).toBeDefined();
  await secondChatReady(page);
  await page.locator("#ta").press("Enter");
  await expect(page.locator(".turn.u").last()).toContainText("A question for the other model");
  await expect(warning(page)).toHaveCount(0);
  const target = await page.locator(".sb-row.on").getAttribute("data-thread");
  expect(target).not.toBeNull();
  await page.locator(`.sb-row[data-thread="${victim}"]`).click();
  await expect(page.locator(".stop-note")).toHaveText("Stopped so Qwen 3.5 9B could load. Its text is kept here and excluded from later model prompts.");
  await expect(page.locator(".turn.a.interrupted .md ul li")).toHaveCount(3);
  await expect(page.locator(".writing")).toHaveCount(0);
  await expect.poll(() => sends.findLast((send) => send.threadId === target)?.stopOthers).toBe(true);
  await expect.poll(async () => (await runtimeState()).turns.find((turn) => turn.id === running?.id)?.outcome).toBe("cancelled");
  await shot(page, "05-optout-stopped-chat");
});
