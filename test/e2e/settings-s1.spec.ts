/// <reference lib="dom" />
// Journeys: Settings choices the owner made. The Tools switch really changes
// what a chat is offered, Text size is gone, and Accent applies at once and
// persists.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { type Params, createClient } from "@gates-local/contracts";
import type { Page } from "@playwright/test";
import { CHECKOUT_CACHE, FAKE_URL } from "./env.ts";
import { expect, navButton, sendMessage, test, waitReady } from "./fixtures.ts";

const section = async (page: Page, label: string) => {
  await page.keyboard.press("Control+Comma");
  await navButton(page, label).click();
};

const replied = async (page: Page, count: number) => {
  await expect(page.locator(".turn.a.done")).toHaveCount(count, { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
};

interface ChatRequest {
  path: string;
  body: { tools?: unknown[]; messages?: { content?: string }[] };
}

/** Whether any chat request carrying this text offered the model tools. */
async function toolsOffered(text: string): Promise<boolean> {
  const state = (await (await fetch(`${FAKE_URL}/__fake/state`)).json()) as { requests: ChatRequest[] };
  const asked = state.requests.filter((r) => r.path === "/api/chat" && r.body.messages?.some((m) => m.content?.includes(text)));
  expect(asked.length).toBeGreaterThan(0);
  return asked.some((r) => (r.body.tools?.length ?? 0) > 0);
}

// Guards the owner's ruling: the Tools switch decides whether a chat is offered tools.
test("the Tools switch decides whether a chat is offered tools", async ({ page, open }) => {
  const folder = path.join(CHECKOUT_CACHE, "e2e-library", "tools-notes");
  mkdirSync(folder, { recursive: true });
  await open();
  await waitReady(page);
  await section(page, "Library");
  await page.getByTestId("settings.library.add-folder").click();
  await page.getByTestId("settings.add-source.path-folder").fill(folder);
  await page.getByTestId("settings.add-source.add-folder").click();
  await expect(page.locator(".srow .sl b", { hasText: "tools-notes" })).toBeVisible();
  await page.keyboard.press("Escape");
  await waitReady(page);

  await sendMessage(page, "first question with tools on");
  await replied(page, 1);
  expect(await toolsOffered("first question with tools on")).toBe(true);

  await section(page, "Tools");
  const master = page.getByTestId("settings.tools.enable");
  await expect(master).toHaveAttribute("aria-checked", "true");
  await master.click();
  await expect(master).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await waitReady(page);

  await sendMessage(page, "second question with tools off");
  await replied(page, 2);
  expect(await toolsOffered("second question with tools off")).toBe(false);
});

// Guards the owner's ruling: Text size is gone, even for settings an older app saved.
test("there is no Text size: messages and the message box are 15 px, even after an older app saved Large", async ({ page, open }) => {
  await open();
  await waitReady(page);
  // what an app from before the removal sends; it must not fail, and it changes nothing
  const server = new URL(page.url()).searchParams.get("server");
  if (!server) throw new Error("No test server URL");
  const old = createClient(new WebSocket(server));
  await old.call("settings.update", { textSize: "large" } as Params<"settings.update">);
  old.close();
  await page.reload();
  await waitReady(page);
  await sendMessage(page, "How big is this text?");
  await replied(page, 1);
  const fontSize = (selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).fontSize);
  expect(await fontSize(".md")).toBe("15px");
  expect(await fontSize("#ta")).toBe("15px");
  expect(await fontSize(".bubble")).toBe("15px");
  await expect(page.locator("html")).not.toHaveAttribute("data-text", /./);

  await section(page, "General");
  await expect(page.getByRole("group", { name: "Theme" })).toBeVisible();
  await expect(page.getByText("Text size", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Text size" })).toHaveCount(0);
  await page.getByTestId("settings.nav.open-advanced").click();
  await page.getByTestId("settings.advanced.reset").click();
  await expect(page.getByRole("group", { name: "Confirm reset" })).not.toContainText("text size");
});

// Guards the owner's ruling on Accent: Neutral first, applies at once, semantic colours stay, survives a reload.
test("Accent starts Neutral, a pick sets --accent at once in this theme's step, the semantic colours stay, and it survives a reload", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const token = (name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
  const semantic = async () => [await token("--green"), await token("--amber"), await token("--red")];
  await section(page, "General");
  const accent = page.getByRole("group", { name: "Accent" });
  await expect(accent.getByRole("button")).toHaveCount(6);
  for (const [i, name] of ["Neutral", "Green", "Blue", "Violet", "Amber", "Red"].entries()) await expect(accent.getByRole("button").nth(i)).toHaveAccessibleName(name);
  await expect(accent.getByRole("button", { name: "Neutral" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).not.toHaveAttribute("data-accent", /./);
  expect(await token("--accent")).toBe(await token("--foreground"));
  const before = await semantic();

  await accent.getByRole("button", { name: "Blue" }).click();
  await expect(accent.getByRole("button", { name: "Blue" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "blue");
  expect(await token("--accent")).toBe("#3b82f6");
  expect(await semantic()).toEqual(before);
  await page.getByTestId("settings.segment.theme-light").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await token("--accent")).toBe("#2563eb");

  await page.reload();
  await waitReady(page);
  await expect(page.locator("html")).toHaveAttribute("data-accent", "blue");
  await section(page, "General");
  await expect(page.getByRole("group", { name: "Accent" }).getByRole("button", { name: "Blue" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("group", { name: "Accent" }).getByRole("button", { name: "Neutral" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-accent", /./);
  expect(await token("--accent")).toBe(await token("--foreground"));
});
