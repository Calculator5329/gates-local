// The Instructions screen uses the existing Settings shell. Its saves reach a real
// server and the fake Ollama; no production runtime or GPU is involved.
import type { Page } from "@playwright/test";
import { FAKE_URL } from "./env.ts";
import { expect, sendMessage, test, waitReady } from "./fixtures.ts";

async function instructions(page: Page) {
  await page.keyboard.press("Control+Comma");
  await page.getByTestId("settings.nav.open-instructions").click();
  await expect(page.getByRole("heading", { name: "Instructions", exact: true })).toBeVisible();
}
async function prompt(page: Page, text: string) {
  const custom = page.locator(".inst-check input");
  await custom.check();
  await page.getByTestId("settings.instructions.prompt").fill(text);
  await page.getByTestId("settings.instructions.save").click();
  await expect(page.locator(".inst-prompt [role=status]")).toHaveText("Saved");
}
interface ChatBody { messages: { role: string; content: string }[]; options: Record<string, number>; keep_alive?: number }
async function bodies(): Promise<ChatBody[]> {
  const state = await (await fetch(`${FAKE_URL}/__fake/state`)).json() as { requests: { path: string; body: ChatBody }[] };
  return state.requests.filter(r => r.path === "/api/chat" && r.body.messages?.some(m => m.role === "user")).map(r => r.body);
}
const mode = (page: Page, control: string, choice: "default" | "custom") => page.getByTestId(`settings.segment.reply-${control}-${choice}`);
const replies = async (page: Page, count: number) => { await expect(page.locator(".turn.a.done")).toHaveCount(count, { timeout: 15000 }); };

// Guards the owner's asks on Instructions: saves reach the model, Reset all clears them, and the "?" beside the scope tabs is gone.
test("Instructions saves shared and per-model settings, sends them to Ollama, and Reset all clears them", async ({ page, open }) => {
  await open(); await waitReady(page); await instructions(page);
  // The owner took out the "?" beside the scope tabs; its sentence is not moved anywhere.
  await expect(page.locator(".inst-top")).not.toContainText("?");
  await expect(page.getByLabel("When changes apply", { exact: true })).toHaveCount(0);
  await prompt(page, "Shared instructions");
  await page.keyboard.press("Escape"); await waitReady(page); await sendMessage(page, "shared question"); await replies(page, 1);
  // the system prompt is the instructions, then the app's own lines (the image line since the image batch landing)
  expect((await bodies()).at(-1)?.messages[0]?.content).toMatch(/^Shared instructions(\n|$)/);
  await instructions(page);
  await page.getByTestId("settings.instructions.scope-model").click();
  await expect(page.getByRole("button", { name: /^Installed model: / })).toHaveAccessibleName("Installed model: Qwen 3.5 9B");
  await prompt(page, "Model instructions");
  await mode(page, "temperature", "custom").click();
  await page.getByTestId("settings.reply-controls.value-temperature").fill("0.25");
  await mode(page, "keep-alive", "custom").click();
  await page.getByTestId("settings.reply-controls.value-keep-alive").fill("0");
  await page.getByTestId("settings.reply-controls.save").click();
  await expect(page.locator(".inst-controls [role=status]")).toHaveText("Saved");
  await page.getByText("What Qwen 3.5 9B ships with", { exact: true }).click();
  await expect(page.locator(".inst-defaults [role=status]")).toHaveText("Read only");
  await page.reload(); await waitReady(page); await instructions(page);
  await page.getByTestId("settings.instructions.scope-model").click();
  await expect(page.getByTestId("settings.instructions.prompt")).toHaveValue("Model instructions");
  await expect(page.getByTestId("settings.reply-controls.value-temperature")).toHaveValue("0.25");
  await page.keyboard.press("Escape"); await waitReady(page); await sendMessage(page, "model question"); await replies(page, 2);
  const body = (await bodies()).at(-1)!;
  expect(body.messages[0]?.content).toMatch(/^Model instructions(\n|$)/); expect(body.options.temperature).toBe(0.25); expect(body.keep_alive).toBe(0); expect(body.options).not.toHaveProperty("num_gpu");
  await page.keyboard.press("Control+Comma");
  await page.getByTestId("settings.nav.open-advanced").click();
  await page.getByTestId("settings.advanced.reset").click();
  await page.getByTestId("settings.advanced.reset-confirm").click();
  await expect(page.getByTestId("settings.advanced.reset-confirm")).toHaveCount(0);
  await page.getByTestId("settings.nav.open-instructions").click();
  await expect(page.locator(".inst-check input")).not.toBeChecked();
  await page.getByTestId("settings.instructions.scope-model").click();
  await expect(page.locator(".inst-check input")).not.toBeChecked();
  await expect(mode(page, "temperature", "default")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape"); await waitReady(page); await sendMessage(page, "reset question"); await replies(page, 3);
  const cleared = (await bodies()).at(-1)!;
  expect(JSON.stringify(cleared.messages)).not.toMatch(/Shared instructions|Model instructions/);
  expect(cleared.options).not.toHaveProperty("temperature"); expect(cleared).not.toHaveProperty("keep_alive");
});
