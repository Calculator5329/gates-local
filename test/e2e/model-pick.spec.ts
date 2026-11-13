// Journey: an embedding model is the smallest installed one. The first run
// still recommends a chat model, the chat starts on it, the picker never
// offers the embedding model, and the Thinking pill follows the model's
// capabilities. The picker is a combobox a screen reader can follow.
import type { Page } from "@playwright/test";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

test.use({ scenario: "embed-smallest" });

const EMBED = "nomic-embed-text:latest";

async function pickModel(page: Page, query: string, tag: string): Promise<void> {
  await page.locator("#modelBtn").click();
  await page.locator("#pkSearch").fill(query);
  await page.locator(`#picker .pk-r[data-m="${tag}"]`).click();
  await expect(page.locator("#picker")).toBeHidden();
}

test.describe("first run", () => {
  test.use({ skipFirstRun: false });

  test("recommends a chat model, not the smaller embedding model, and Start chatting sends a turn", async ({ page, open }) => {
    await open();
    await expect(page.getByRole("heading", { name: "Ready to chat" })).toBeVisible();
    await expect(page.locator(".fr-st")).toContainText("3 chat models");
    await expect(page.locator(".fr-card .nm")).toHaveText("Qwen 3.5 9B");
    await expect(page.locator(".fr-card .v")).toHaveText("Runs on GPU");
    await page.getByRole("button", { name: "Start chatting" }).click();

    await expect(page.locator("#modelBtn")).toContainText("Qwen 3.5 9B");
    await sendMessage(page, "Say hello");
    const reply = page.locator(".turn.a").last();
    await expect(reply.locator(".md")).toContainText("You asked: Say hello");
    await expect(page.locator(".writing")).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator(".c-note")).toHaveCount(0);
  });

  test.describe("at 1440 px", () => {
    test.use({ viewport: { width: 1440, height: 900 } });
    test("Ready to chat says nothing its title says, has no blurb or footer, and leaves no gap for them", async ({ page, open }) => {
      await open();
      const fr = page.locator(".fr");
      await expect(page.getByRole("heading", { name: "Ready to chat" })).toBeVisible();
      await expect(fr.locator(".fr-card .v")).toHaveText("Runs on GPU");
      await page.screenshot({ path: test.info().outputPath("first-run-ready-1440.png") });
      // the title is the news; the card is the model, its fit and its details
      await expect(fr.locator(".sub")).toHaveCount(0);
      await expect(fr).not.toContainText("Switch models in any chat");
      await expect(fr.locator(".fr-card .fr-sub")).toHaveCount(0);
      await expect(fr).not.toContainText("Fast everyday answers");
      await expect(fr.locator(".fr-foot")).toHaveCount(0);
      await expect(fr).not.toContainText("Nothing leaves your own network");
      const g = await fr.evaluate((el) => {
        const h = el.querySelector("h1")?.getBoundingClientRect();
        const card = el.querySelector(".fr-card")?.getBoundingClientRect();
        return { gap: (card?.top ?? 0) - (h?.bottom ?? 0), width: el.getBoundingClientRect().width, bottom: el.getBoundingClientRect().bottom, cta: el.querySelector(".fr-cta")?.getBoundingClientRect().bottom ?? 0 };
      });
      expect(g.width).toBeLessThanOrEqual(540);
      expect(g.gap, "the card sits the usual 24 px under the title").toBe(24);
      expect(g.bottom - g.cta, "nothing reserved under the buttons").toBeLessThanOrEqual(0.5);
    });
  });
});

test("the picker never lists the embedding model and is a connected combobox and listbox", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await expect(page.locator("#modelBtn")).toContainText("Qwen 3.5 9B");
  await page.locator("#modelBtn").click();
  const picker = page.locator("#picker");
  await expect(picker).toBeVisible();
  await expect(picker.locator(".pk-r")).toHaveCount(3);
  await expect(picker.locator(`[data-m="${EMBED}"]`)).toHaveCount(0);
  await expect(picker).not.toContainText(/nomic/i);

  const box = page.getByRole("combobox", { name: "Search models" });
  await expect(box).toHaveAttribute("aria-expanded", "true");
  await expect(box).toHaveAttribute("aria-controls", "pkList");
  const list = page.locator("#pkList");
  await expect(list).toHaveAttribute("role", "listbox");
  await expect(list.getByRole("option")).toHaveCount(3);
  // before any arrow key the selected option is the chat's model
  await expect(list.getByRole("option", { selected: true })).toHaveAttribute("data-m", "qwen3.5:9b");
  await expect(box).not.toHaveAttribute("aria-activedescendant", /./);

  await box.press("ArrowDown");
  await expect(box).toHaveAttribute("aria-activedescendant", "pk-opt-0");
  await expect(page.locator("#pk-opt-0")).toHaveAttribute("aria-selected", "true");
  await box.press("ArrowDown");
  await expect(box).toHaveAttribute("aria-activedescendant", "pk-opt-1");
  await expect(page.locator("#pk-opt-1")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#pk-opt-0")).toHaveAttribute("aria-selected", "false");
  await expect(list.getByRole("option", { selected: true })).toHaveCount(1);
  // the 27B cannot load at 16k: an option a reader hears as unavailable
  await expect(list.locator('.pk-r.dis[data-m="qwen3.8-abliterated:27b"]')).toHaveAttribute("aria-disabled", "true");
});

test("the Thinking pill is on for a model that thinks and greyed with a reason for one that does not", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const pill = page.getByRole("button", { name: "Thinking", exact: true });
  await expect(page.locator("#modelBtn")).toContainText("Qwen 3.5 9B");
  await expect(pill).not.toHaveAttribute("aria-disabled", /./);
  await expect(pill).not.toHaveClass(/unavail/);
  const before = await pill.getAttribute("aria-pressed");
  await pill.click();
  await expect(pill).not.toHaveAttribute("aria-pressed", before ?? "");
  await pill.click();
  await expect(pill).toHaveAttribute("aria-pressed", before ?? "");

  await pickModel(page, "gemma", "gemma4:12b");
  await expect(page.locator("#modelBtn")).toContainText("Gemma 4 12B");
  await expect(pill).toHaveAttribute("aria-disabled", "true");
  await expect(pill).toHaveAttribute("aria-pressed", "false");
  await expect(pill).toHaveText("Thinking");
  await expect(pill).toHaveAttribute("data-tip", /Gemma 4 12B does not reason before answering/);
  const greyed = await pill.evaluate((el) => ({ opacity: getComputedStyle(el).opacity, cursor: getComputedStyle(el).cursor }));
  expect(greyed).toEqual({ opacity: "0.4", cursor: "not-allowed" });
  const pressed = await pill.getAttribute("aria-pressed");
  // Playwright will not click an aria-disabled control; a user still can, and nothing may change.
  await pill.dispatchEvent("click");
  await expect(pill).toHaveAttribute("aria-pressed", pressed ?? "");

  // a turn on the model that cannot think still answers (the server leaves think out)
  await sendMessage(page, "Hello gemma");
  await expect(page.locator(".turn.a").last().locator(".md")).toContainText("You asked: Hello gemma");
  // The terminal event invalidates fit advice; finish the reply before choosing again.
  await expect(page.locator(".turn.a").last()).toHaveClass(/\bdone\b/);

  await pickModel(page, "qwen", "qwen3.5:9b");
  await expect(pill).not.toHaveAttribute("aria-disabled", /./);
});

test.describe("first download", () => {
  test.use({ scenario: "no-models", skipFirstRun: false });

  test("the Thinking pill waits for the first chat model to finish downloading (F70)", async ({ page, open }) => {
    await open();
    await page.getByRole("button", { name: "Download and start" }).click();
    await page.getByRole("button", { name: "Start chatting" }).click();
    const pill = page.getByRole("button", { name: "Thinking", exact: true });
    await expect(pill).toHaveAttribute("aria-disabled", "true");
    await expect(pill).toHaveAttribute("aria-pressed", "false");
    await expect(pill).toHaveText("Thinking");
    await expect(pill).toHaveAttribute("data-tip", "Available when the model finishes downloading.");
    // Qwen 3.5 9B thinks, so the pill comes on once it is installed
    await expect(pill).not.toHaveAttribute("aria-disabled", /./, { timeout: 20_000 });
    await expect(pill).toHaveAttribute("data-tip", /^<b>Thinking (on|off)\.<\/b>/);
  });
});

test.describe("first download with only an embedding model installed (MP-04)", () => {
  test.use({ scenario: "embed-only", skipFirstRun: false });

  test("shows the download's progress and Start chatting, and a typed message waits for it", async ({ page, open }) => {
    await open();
    await expect(page.getByRole("heading", { name: "Download your first model" })).toBeVisible();
    await expect(page.locator(".fr-st")).toContainText("no chat models yet");
    await page.getByRole("button", { name: "Download and start" }).click();
    await expect(page.getByRole("heading", { name: "Downloading your first model" })).toBeVisible();
    await expect(page.getByRole("progressbar")).toBeVisible();
    await page.getByRole("button", { name: "Start chatting" }).click();
    await sendMessage(page, "Hello there");
    await expect(page.locator(".qt-r")).toContainText("After download");
    await expect(page.locator(".turn.a .md").last()).toContainText("You asked: Hello there", { timeout: 20_000 });
    await expect(page.locator("#modelBtn")).toContainText("Qwen 3.5 9B");
  });
});

// The open chat keeping the user's model when the pick changes is the unit test's (apps/web/src/pick.test.ts).
test("one Ctrl+N after saving a default starts the new chat on the new pick, even when the pick lands after the chat exists (MP-05)", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const modelBtn = page.locator("#modelBtn");
  // The user picks Qwen themselves, so only a new chat may move off it.
  await pickModel(page, "qwen", "qwen3.5:9b");
  await expect(modelBtn).toContainText("Qwen 3.5 9B");
  await expect(modelBtn).not.toContainText("loading");
  // Hold every /api/show, so the pick that follows the new default lands only after the new chat
  // exists. A Qwen load that lands after this call stays resident, and must not keep the pick on it.
  await stack.scenario("embed-smallest", { showDelayMs: 1500 });
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Models", exact: true }).click();
  const gemma = page.locator(`.mp-row[data-dm="gemma4:12b"]`);
  await gemma.getByRole("button", { name: /^More for / }).click();
  await page.getByRole("menuitem", { name: "Use as default" }).click();
  await expect(gemma.locator(".mp-l1 .mp-chip")).toHaveText("Default");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+n");
  await expect(modelBtn).toContainText("Qwen 3.5 9B"); // the survey is still held
  await expect(modelBtn).toContainText("Gemma 4 12B", { timeout: 20_000 });
});

test("Settings lists the embedding model as not for chat, with Remove and no default choice", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Models", exact: true }).click();
  const row = page.locator(`.mp-row.emb[data-em="${EMBED}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator(".mp-fitc")).toContainText("Embedding model, not for chat");
  await expect(row.getByRole("button")).toHaveCount(1);
  await row.getByRole("button", { name: /^More for / }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: /^Remove…/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Use as default" })).toHaveCount(0);
  await expect(page.locator(`.mp-row[data-dm="${EMBED}"]`)).toHaveCount(0);
  // the three chat models are rows, the 27b among them (it won't run here, so it is dimmed)
  await expect(page.locator(".mp-row[data-dm]")).toHaveCount(3);
  // nor can the Default card choose it: two choices, and the 27b disabled with its reason
  await page.getByRole("button", { name: /^Default for new chats:/ }).click();
  const options = page.getByRole("listbox", { name: "Installed chat models" }).getByRole("option");
  await expect(options).toHaveCount(3);
  await expect(options.filter({ hasText: EMBED.split(":")[0] ?? EMBED })).toHaveCount(0);
  await expect(page.locator('.mp-opt[aria-disabled="true"]')).toHaveCount(1);
});
