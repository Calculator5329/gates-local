// Review probes: two real clients share the server, while each keeps its own unsaved edits.
import type { Page } from "@playwright/test";
import { MODEL_CONTROL_BOUNDS } from "@gates-local/contracts";
import { expect, test, waitReady } from "./fixtures.ts";

function sentRequests(page: Page): { method: string; params: unknown }[] {
  const requests: { method: string; params: unknown }[] = [];
  page.on("websocket", socket => socket.on("framesent", frame => {
    if (typeof frame.payload !== "string") return;
    let value: unknown;
    try { value = JSON.parse(frame.payload); } catch { return; }
    // Inspect the actual outgoing fields without schema decoding stripping anything.
    if (typeof value === "object" && value !== null && "type" in value && value.type === "request" && "method" in value && typeof value.method === "string" && "params" in value) requests.push({ method: value.method, params: value.params });
  }));
  return requests;
}
async function instructions(page: Page) {
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Instructions", exact: true }).click();
  await expect(page.getByRole("button", { name: "Per model", exact: true })).toBeVisible();
}
async function savePrompt(page: Page, text: string) {
  await page.locator(".inst-check input").check();
  await page.getByRole("textbox", { name: "System prompt", exact: true }).fill(text);
  await page.getByRole("button", { name: "Save instructions", exact: true }).click();
  await expect(page.locator(".inst-prompt [role=status]")).toHaveText("Saved");
}
async function custom(page: Page, label: string, value: string) {
  await page.getByRole("group", { name: `${label} mode`, exact: true }).getByRole("button", { name: "Custom", exact: true }).click();
  await page.getByRole("spinbutton", { name: label, exact: true }).fill(value);
}

test("MS-01: two clients save only edited fields and preserve controls and prompt drafts", async ({ page, open }, info) => {
  const requests = sentRequests(page);
  await open(); await waitReady(page);
  const other = await page.context().newPage();
  try {
    await other.goto(page.url()); await waitReady(other);
    await instructions(page); await instructions(other);
    await page.getByRole("button", { name: "Per model", exact: true }).click();
    await other.getByRole("button", { name: "Per model", exact: true }).click();
    await custom(page, "Temperature", "0.5");
    await custom(other, "Seed", "42");
    await other.getByRole("button", { name: "Save controls", exact: true }).click();
    await expect(other.locator(".inst-controls [role=status]")).toHaveText("Saved");
    await expect(page.getByRole("spinbutton", { name: "Seed", exact: true })).toHaveValue("42");
    await expect(page.getByRole("spinbutton", { name: "Temperature", exact: true })).toHaveValue("0.5");
    await page.getByRole("button", { name: "Save controls", exact: true }).click();
    await expect(page.locator(".inst-controls [role=status]")).toHaveText("Saved");
    expect(requests.findLast(r => r.method === "settings.model.update")?.params).toEqual({ model: "qwen3.5:9b", patch: { temperature: 0.5 } });
    await expect(other.getByRole("spinbutton", { name: "Seed", exact: true })).toHaveValue("42");
    await expect(other.getByRole("spinbutton", { name: "Temperature", exact: true })).toHaveValue("0.5");

    await page.locator(".inst-check input").check();
    await page.getByRole("textbox", { name: "System prompt", exact: true }).fill("Local model draft");
    await savePrompt(other, "Other client's model prompt");
    await expect(page.getByRole("textbox", { name: "System prompt", exact: true })).toHaveValue("Local model draft");
    await page.getByRole("button", { name: "Save instructions", exact: true }).click();
    await expect(page.locator(".inst-prompt [role=status]")).toHaveText("Saved");
    expect(requests.findLast(r => r.method === "settings.model.update")?.params).toEqual({ model: "qwen3.5:9b", patch: { systemPrompt: "Local model draft" } });
    await expect(other.getByRole("spinbutton", { name: "Seed", exact: true })).toHaveValue("42");

    await page.getByRole("button", { name: "All chats", exact: true }).click();
    await other.getByRole("button", { name: "All chats", exact: true }).click();
    await page.locator(".inst-check input").check();
    await page.getByRole("textbox", { name: "System prompt", exact: true }).fill("Local shared draft");
    await savePrompt(other, "Other client's shared prompt");
    await expect(page.getByRole("textbox", { name: "System prompt", exact: true })).toHaveValue("Local shared draft");
    await page.getByRole("button", { name: "Save instructions", exact: true }).click();
    await expect(page.locator(".inst-prompt [role=status]")).toHaveText("Saved");
    expect(requests.findLast(r => r.method === "settings.update")?.params).toEqual({ systemPrompt: "Local shared draft" });
    await other.getByRole("button", { name: "Per model", exact: true }).click();
    await expect(other.getByRole("textbox", { name: "System prompt", exact: true })).toHaveValue("Local model draft");
    await expect(other.getByRole("spinbutton", { name: "Seed", exact: true })).toHaveValue("42");
    await page.screenshot({ path: info.outputPath("shared-prompt-draft.png"), fullPage: true });
  } finally { await other.close(); }
});

test("MS-02: every numeric input shares the schema's upper bound and refuses an oversized save", async ({ page, open }, info) => {
  const requests = sentRequests(page);
  await open(); await waitReady(page); await instructions(page);
  await page.getByRole("button", { name: "Per model", exact: true }).click();
  const labels = { temperature: "Temperature", top_p: "Top p", top_k: "Top k", repeat_penalty: "Repeat penalty", seed: "Seed", num_predict: "Maximum reply length", keep_alive: "Keep loaded" };
  for (const key of Object.keys(MODEL_CONTROL_BOUNDS) as (keyof typeof MODEL_CONTROL_BOUNDS)[]) {
    const bounds = MODEL_CONTROL_BOUNDS[key], label = labels[key];
    const input = page.getByRole("spinbutton", { name: label, exact: true });
    await expect(input).toHaveAttribute("max", String(bounds.max));
    await expect(input).toHaveAttribute("min", String(key === "num_predict" ? -2 : key === "keep_alive" ? -1 : bounds.min));
    await custom(page, label, String(bounds.max + 1));
    expect(await input.evaluate(el => el instanceof HTMLInputElement && el.validity.rangeOverflow)).toBe(true);
  }
  await page.getByRole("button", { name: "Save controls", exact: true }).click();
  expect(requests.filter(r => r.method === "settings.model.update")).toHaveLength(0);
  await page.getByRole("button", { name: "Reset controls", exact: true }).click();
  await expect(page.locator(".inst-controls [role=status]")).toHaveText("Saved");
  await page.locator(".inst-controls").screenshot({ path: info.outputPath("bounded-controls.png") });
});
