// The Instructions screen uses the existing Settings shell. Its saves reach a real
// server and the fake Ollama; no production runtime or GPU is involved.
import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { FAKE_URL } from "./env.ts";
import { expect, sendMessage, test, waitReady } from "./fixtures.ts";

test.use({ video: process.env["GL_E2E_RECORD"] || process.env["GL_FLICKER_MEASURE"] ? "on" : "off" });
async function instructions(page: Page) {
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Instructions", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Instructions", exact: true })).toBeVisible();
}
async function prompt(page: Page, text: string) {
  const custom = page.locator(".inst-check input");
  await custom.check();
  await page.getByRole("textbox", { name: "System prompt", exact: true }).fill(text);
  await page.getByRole("button", { name: "Save instructions", exact: true }).click();
  await expect(page.locator(".inst-prompt [role=status]")).toHaveText("Saved");
}
interface ChatBody { messages: { role: string; content: string }[]; options: Record<string, number>; keep_alive?: number }
async function bodies(): Promise<ChatBody[]> {
  const state = await (await fetch(`${FAKE_URL}/__fake/state`)).json() as { requests: { path: string; body: ChatBody }[] };
  return state.requests.filter(r => r.path === "/api/chat" && r.body.messages?.some(m => m.role === "user")).map(r => r.body);
}
const letter = (name: string) => name.slice(0, 1).toLowerCase();
const mode = (page: Page, label: string, choice: "Default" | "Custom") => page.getByRole("group", { name: `${label} mode`, exact: true }).getByRole("button", { name: choice, exact: true });
const replies = async (page: Page, count: number) => { await expect(page.locator(".turn.a.done")).toHaveCount(count, { timeout: 15000 }); };
// Clicks may scroll Settings. Compare layout coordinates, not the viewport's scroll position.
const geometry = (locator: Locator) => locator.evaluate(el => {
  const rect = el.getBoundingClientRect();
  return { x: rect.x, y: rect.y + (el.closest(".set")?.scrollTop ?? 0), width: rect.width, height: rect.height };
});

test("Instructions saves shared and per-model settings, sends them to Ollama, and Reset all clears them", async ({ page, open }, info) => {
  await open(); await waitReady(page); await instructions(page);
  await prompt(page, "Shared instructions");
  await page.keyboard.press("Escape"); await waitReady(page); await sendMessage(page, "shared question"); await replies(page, 1);
  expect((await bodies()).at(-1)?.messages[0]?.content).toBe("Shared instructions");
  await instructions(page);
  await page.getByRole("button", { name: "Per model", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Installed model: / })).toHaveAccessibleName("Installed model: Qwen 3.5 9B");
  await prompt(page, "Model instructions");
  await mode(page, "Temperature", "Custom").click();
  await page.getByRole("spinbutton", { name: "Temperature", exact: true }).fill("0.25");
  await mode(page, "Keep loaded", "Custom").click();
  await page.getByRole("spinbutton", { name: "Keep loaded", exact: true }).fill("0");
  await page.getByRole("button", { name: "Save controls", exact: true }).click();
  await expect(page.locator(".inst-controls [role=status]")).toHaveText("Saved");
  await page.getByText("What Qwen 3.5 9B ships with", { exact: true }).click();
  await expect(page.locator(".inst-defaults [role=status]")).toHaveText("Read only");
  await page.locator(".set").evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: info.outputPath("instructions-desktop.png"), fullPage: true });
  await page.locator(".inst-controls").screenshot({ path: info.outputPath("instructions-controls.png") });
  await page.locator(".inst-defaults").screenshot({ path: info.outputPath("instructions-defaults.png") });
  await page.reload(); await waitReady(page); await instructions(page);
  await page.getByRole("button", { name: "Per model", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "System prompt", exact: true })).toHaveValue("Model instructions");
  await expect(page.getByRole("spinbutton", { name: "Temperature", exact: true })).toHaveValue("0.25");
  await page.keyboard.press("Escape"); await waitReady(page); await sendMessage(page, "model question"); await replies(page, 2);
  const body = (await bodies()).at(-1)!;
  expect(body.messages[0]?.content).toBe("Model instructions"); expect(body.options.temperature).toBe(0.25); expect(body.keep_alive).toBe(0); expect(body.options).not.toHaveProperty("num_gpu");
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Advanced", exact: true }).click();
  await page.getByRole("button", { name: "Reset…", exact: true }).click();
  await page.getByRole("group", { name: "Confirm reset" }).getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.getByRole("group", { name: "Confirm reset" })).toHaveCount(0);
  await page.locator(".snav").getByRole("button", { name: "Instructions", exact: true }).click();
  await expect(page.locator(".inst-check input")).not.toBeChecked();
  await page.getByRole("button", { name: "Per model", exact: true }).click();
  await expect(page.locator(".inst-check input")).not.toBeChecked();
  await expect(mode(page, "Temperature", "Default")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape"); await waitReady(page); await sendMessage(page, "reset question"); await replies(page, 3);
  const cleared = (await bodies()).at(-1)!;
  expect(JSON.stringify(cleared.messages)).not.toMatch(/Shared instructions|Model instructions/);
  expect(cleared.options).not.toHaveProperty("temperature"); expect(cleared).not.toHaveProperty("keep_alive");
});

test("Instructions keeps control sizes across default, custom, saving and saved states", async ({ page, open }) => {
  let held: { approve(): void; refuse(): void } | undefined;
  await page.routeWebSocket(/127\.0\.0\.1:5286/, ws => {
    const server = ws.connectToServer();
    ws.onMessage(message => {
      const frame = typeof message === "string" ? JSON.parse(message) as { type?: string; method?: string; id?: string } : undefined;
      if (frame?.type === "request" && frame.method === "settings.model.update") {
        held = { approve: () => server.send(message), refuse: () => ws.send(JSON.stringify({ type: "response", id: frame.id, ok: false, error: { code: "disk-full", message: "Test: no space left" } })) };
      } else server.send(message);
    });
    server.onMessage(message => ws.send(message));
  });
  await open(); await waitReady(page); await instructions(page);
  await page.getByRole("button", { name: "Per model", exact: true }).click();
  const row = page.locator(".srow", { has: page.getByRole("spinbutton", { name: "Temperature", exact: true }) });
  const box = await geometry(row);
  await mode(page, "Temperature", "Custom").click();
  expect(await geometry(row)).toEqual(box);
  await page.getByRole("spinbutton", { name: "Temperature", exact: true }).fill("0.5");
  const save = page.getByRole("button", { name: "Save controls", exact: true }), button = await geometry(save);
  await save.click(); await expect.poll(() => held !== undefined).toBe(true);
  await expect(page.locator(".inst-controls [role=status]")).toHaveText("Saving…");
  expect(await geometry(save)).toEqual(button); expect(await geometry(row)).toEqual(box);
  held?.approve(); await expect(page.locator(".inst-controls [role=status]")).toHaveText("Saved");
  expect(await geometry(save)).toEqual(button); expect(await geometry(row)).toEqual(box);
  const first = held;
  await page.getByRole("spinbutton", { name: "Temperature", exact: true }).fill("0.7");
  await save.click(); await expect.poll(() => held !== first).toBe(true);
  held?.refuse(); await expect(page.locator(".inst-controls [role=alert]")).toContainText("Test: no space left");
  expect(await geometry(save)).toEqual(button); expect(await geometry(row)).toEqual(box);
  await page.getByRole("button", { name: "Reset Temperature", exact: true }).click();
  expect(await geometry(row)).toEqual(box);
});

test("the installed-model menu works from the keyboard and has no blank choice", async ({ page, open }) => {
  await open(); await waitReady(page); await instructions(page);
  await page.getByRole("button", { name: "Per model", exact: true }).click();
  const button = page.getByRole("button", { name: /^Installed model: / });
  const before = await button.getAttribute("aria-label");
  await button.focus(); await page.keyboard.press("Enter");
  const options = page.getByRole("listbox", { name: "Installed chat models" }).getByRole("option");
  const names = (await options.evaluateAll(els => els.map(el => el.getAttribute("aria-label") ?? ""))).filter(Boolean);
  expect(names.length, "every choice is a model").toBe(await options.count());
  await expect(page.getByRole("option", { selected: true })).toBeFocused();
  // A letter jumps to the next model whose name starts with it.
  const at = names.indexOf(before!.replace("Installed model: ", ""));
  const order = [...names.keys()].map(i => (at + 1 + i) % names.length);
  const hit = order.find(i => letter(names[i]!) !== letter(names[at]!))!;
  const target = names[hit]!;
  await page.keyboard.press(letter(target));
  await expect(options.nth(hit)).toBeFocused();
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Escape");
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute("aria-label", before!);
  await page.keyboard.press("Enter");
  await page.keyboard.press(letter(target)); await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox", { name: "Installed chat models" })).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute("aria-label", `Installed model: ${target}`);
  await expect(page.getByText(`What ${target} ships with`, { exact: true })).toBeVisible();
});

test("an oversized prompt gets a plain error and no chat request", async ({ page, open }) => {
  const message = `oversized-prompt-${randomUUID()}`;
  await open(); await waitReady(page); await instructions(page); await prompt(page, "x".repeat(70000));
  await page.keyboard.press("Escape"); await waitReady(page); await sendMessage(page, message);
  await expect(page.locator(".err-line")).toContainText("system prompt is too long");
  // Older requests can leave the fake's bounded history while this test runs.
  expect((await bodies()).filter(body => body.messages.some(m => m.role === "user" && m.content === message))).toEqual([]);
});

test.describe("Instructions on a phone", () => {
  test.use({ viewport: { width: 360, height: 800 }, hasTouch: true });
  test("scope, prompt and model controls stay within the screen", async ({ page, open }, info) => {
    await open(); await waitReady(page); await page.keyboard.press("Control+Comma");
    await page.getByRole("button", { name: "Back to Settings", exact: true }).click();
    await page.locator(".set-list").getByRole("button", { name: "Instructions", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Instructions", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Per model", exact: true }).click();
    await mode(page, "Temperature", "Custom").tap();
    const row = page.locator(".inst-controls .srow").first();
    expect((await row.boundingBox())?.height, "one label and one control line, without an inherited flex gap").toBeLessThanOrEqual(128);
    await page.getByLabel("When changes apply", { exact: true }).tap();
    await expect(page.locator("#tip")).toContainText("next message");
    await page.locator(".set").evaluate(el => { el.scrollTop = 1; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    expect(await page.locator(".set").evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
    await page.screenshot({ path: info.outputPath("instructions-phone.png"), fullPage: true });
    await page.locator(".set").evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.screenshot({ path: info.outputPath("instructions-phone-controls.png"), fullPage: true });
  });
});
