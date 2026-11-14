import type { Page } from "@playwright/test";
import type { FakeOllama, ScenarioOptions } from "../fake-ollama/fake-ollama.ts";
import { threadReply } from "../fake-ollama/fake-ollama.ts";
import { CONTROL_URL, FAKE_URL } from "./env.ts";
import { expect, sendMessage, test } from "./fixtures.ts";

export const SMALL = ["tiny-chat:2k", "no-limit-chat:1b", "mid-chat:32k"];
export const INSTALLED = [...SMALL, "qwen3.5:9b", "gemma4:12b", "qwen3.8-abliterated:27b"];
export type RuntimeState = ReturnType<FakeOllama["state"]>;
export const state = async (): Promise<RuntimeState> => {
  const r = await fetch(`${FAKE_URL}/__fake/state`);
  expect(r.ok).toBe(true);
  return r.json() as Promise<RuntimeState>;
};
export async function configure(options: ScenarioOptions = {}): Promise<void> {
  const r = await fetch(`${CONTROL_URL}/scenario`, { method: "POST", body: JSON.stringify({ scenario: "threads", installed: INSTALLED, tokenDelayMs: 8, firstTokenDelayMs: 0, ...options }) });
  expect(r.ok).toBe(true);
}
export async function release(prompt?: string): Promise<void> {
  const id = prompt === undefined ? undefined : (await state()).turns.findLast((t) => t.prompt === prompt)?.id;
  if (prompt !== undefined) expect(id).toBeDefined();
  const r = await fetch(`${FAKE_URL}/__fake/release`, { method: "POST", body: JSON.stringify({ id }) });
  expect(r.ok).toBe(true);
}
export async function pick(page: Page, model: string): Promise<void> {
  await page.locator("#modelBtn").click();
  await page.locator("#pkSearch").fill(model.split(":")[0] ?? model);
  await page.locator(`#picker .pk-r[data-m="${model}"]`).click();
  await expect(page.locator("#picker")).toBeHidden();
}
export async function contextSize(page: Page, size: number): Promise<void> {
  // Context is set in the model picker only (decision 13): the chosen model's size rows.
  await page.locator("#modelBtn").click();
  await page.locator(`#picker [data-ctx="${size}"]`).click();
  await expect(page.locator("#picker")).toBeHidden();
}
export async function start(page: Page, prompt: string, model = SMALL[0] ?? "tiny-chat:2k"): Promise<string> {
  await pick(page, model);
  await sendMessage(page, prompt);
  await expect(page.locator(".turn.u").last()).toHaveText(new RegExp(prompt));
  await expect.poll(async () => (await state()).turns.some((t) => t.prompt === prompt)).toBe(true);
  return page.url();
}
export async function finished(page: Page, prompt: string, count = 1): Promise<void> {
  await expect(page.locator(".turn.a:not(.done):not(.interrupted)")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(".turn.a.done")).toHaveCount(count);
  await expect(page.locator(".turn.a.done .md").last()).toHaveText(threadReply(prompt).replaceAll("\n\n", ""));
}
export async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env["GL_SHOTS_DIR"];
  const repeat = test.info().repeatEachIndex;
  const file = `threads-${name}${repeat === 0 ? "" : `-r${repeat}`}.png`;
  // without GL_SHOTS_DIR the shot goes with the test's results, so a remote run brings it back
  await page.screenshot({ path: dir ? `${dir}/${file}` : test.info().outputPath(file) });
}
/** Sample every frame: catches flashes of warnings or duplicated rows between awaits. */
export async function observe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const samples: { dialogs: number; users: number; replies: number }[] = [];
    Object.assign(window, { threadSamples: samples });
    const frame = () => {
      if (samples.length >= 1000) return;
      samples.push({ dialogs: document.querySelectorAll('[role="alertdialog"]').length, users: document.querySelectorAll(".turn.u").length, replies: document.querySelectorAll(".turn.a").length });
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}
export async function noWarnings(page: Page): Promise<void> {
  const seen = await page.evaluate(() => (window as unknown as { threadSamples: { dialogs: number }[] }).threadSamples);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.some((s) => s.dialogs > 0)).toBe(false);
}
