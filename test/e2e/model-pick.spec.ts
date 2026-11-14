// Journey: an embedding model is the smallest installed one. The first run
// still recommends a chat model, the chat starts on it, the picker never
// offers the embedding model, and the Thinking pill follows the model's
// capabilities. The picker is a combobox a screen reader can follow.
import type { Page } from "@playwright/test";
import { expect, openModels, sendMessage, stack, test, waitReady } from "./fixtures.ts";

/**
 * A computer where the 27B cannot load: the 16 GB card and 8 GB of memory. On the stack's 32 GB a
 * model is judged by the memory the computer has (the owner's ruling, 2026-11-13), and there the 27B
 * runs, slower.
 */
const no27b = () => stack.computer(8);

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

  // Guards the owner's ruling: first run recommends a chat model, never an embedding model.
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
    // Guards the owner's rule to say a thing once, on first run (unsure: no owner line on this card).
    test("Ready to chat says nothing its title says, and has no blurb or footer", async ({ page, open }) => {
      await open();
      const fr = page.locator(".fr");
      await expect(page.getByRole("heading", { name: "Ready to chat" })).toBeVisible();
      await expect(fr.locator(".fr-card .v")).toHaveText("Runs on GPU");
      // the title is the news; the card is the model, its fit and its details
      await expect(fr.locator(".sub")).toHaveCount(0);
      await expect(fr).not.toContainText("Switch models in any chat");
      await expect(fr.locator(".fr-card .fr-sub")).toHaveCount(0);
      await expect(fr).not.toContainText("Fast everyday answers");
      await expect(fr.locator(".fr-foot")).toHaveCount(0);
      await expect(fr).not.toContainText("Nothing leaves your own network");
    });
  });
});

// Guards the owner's ruling: the picker never offers an embedding model for chat.
test("the picker never lists the embedding model and is a connected combobox and listbox", async ({ page, open }) => {
  await no27b();
  await open();
  await waitReady(page);
  await expect(page.locator("#modelBtn")).toContainText("Qwen 3.5 9B");
  await page.locator("#modelBtn").click();
  const picker = page.locator("#picker");
  await expect(picker).toBeVisible();
  await expect(picker.locator(".pk-r")).toHaveCount(3);
  await expect(picker.locator(`[data-m="${EMBED}"]`)).toHaveCount(0);
  await expect(picker).not.toContainText(/nomic/i);

  const box = page.getByTestId("models.picker.search");
  await expect(box).toHaveAttribute("aria-expanded", "true");
  await expect(box).toHaveAttribute("aria-controls", "pkList");
  const list = page.locator("#pkList");
  await expect(list).toHaveAttribute("role", "listbox");
  await expect(list.getByRole("option")).toHaveCount(3);
  // before any arrow key the selected option is the chat's model
  await expect(list.getByRole("option", { selected: true })).toHaveAttribute("data-m", "qwen3.5:9b");
  await expect(box).not.toHaveAttribute("aria-activedescendant", /./);

  // the arrow keys move from the model in use, so the first one lands on the row after it
  const at = Number(await list.getByRole("option", { selected: true }).getAttribute("data-i"));
  const next = (at + 1) % 3, after = (at + 2) % 3;
  await box.press("ArrowDown");
  await expect(box).toHaveAttribute("aria-activedescendant", `pk-opt-${next}`);
  await expect(page.locator(`#pk-opt-${next}`)).toHaveAttribute("aria-selected", "true");
  await box.press("ArrowDown");
  await expect(box).toHaveAttribute("aria-activedescendant", `pk-opt-${after}`);
  await expect(page.locator(`#pk-opt-${after}`)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(`#pk-opt-${next}`)).toHaveAttribute("aria-selected", "false");
  await expect(list.getByRole("option", { selected: true })).toHaveCount(1);
  // the 27B cannot load at 16k: an option a reader hears as unavailable
  await expect(list.locator('.pk-r.dis[data-m="qwen3.8-abliterated:27b"]')).toHaveAttribute("aria-disabled", "true");
});

// Guards the owner's rule to show only what is true: Thinking is greyed with a reason on a model that cannot think (unsure: no direct owner line).
test("the Thinking pill is on for a model that thinks and greyed with a reason for one that does not", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const pill = page.getByTestId("chat.composer.thinking");
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

  // Guards the F70 fix: Thinking was offered before the first model had downloaded (unsure: could not confirm F70 is the owner's item).
  test("the Thinking pill waits for the first chat model to finish downloading (F70)", async ({ page, open }) => {
    await open();
    await page.getByRole("button", { name: "Download and start" }).click();
    await page.getByRole("button", { name: "Start chatting" }).click();
    const pill = page.getByTestId("chat.composer.thinking");
    await expect(pill).toHaveAttribute("aria-disabled", "true");
    await expect(pill).toHaveAttribute("aria-pressed", "false");
    await expect(pill).toHaveText("Thinking");
    await expect(pill).toHaveAttribute("data-tip", "Available when the model finishes downloading.");
    // Qwen 3.5 9B thinks, so the pill comes on once it is installed
    await expect(pill).not.toHaveAttribute("aria-disabled", /./, { timeout: 20_000 });
    await expect(pill).toHaveAttribute("data-tip", /^<b>Thinking (on|off)\.<\/b>/);
  });
});

// Guards the owner's rulings: embedding models are not for chat, and Remove lives in the row's ⋯ menu.
test("Settings lists the embedding model as not for chat, with Remove and no default choice", async ({ page, open }) => {
  await no27b();
  await open();
  await waitReady(page);
  await openModels(page);
  const row = page.locator(`.mp-row.emb[data-em="${EMBED}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator(".mp-fitc")).toContainText("Embedding model, not for chat");
  await expect(row.getByRole("button")).toHaveCount(1);
  await row.getByTestId("models.row-menu.open").click();
  const menu = page.getByRole("menu");
  await expect(menu.getByTestId("models.row-menu.remove")).toBeVisible();
  await expect(menu.getByTestId("models.row-menu.make-default")).toHaveCount(0);
  await expect(page.locator(`.mp-row[data-dm="${EMBED}"]`)).toHaveCount(0);
  // the three chat models are rows, the 27b among them (it won't run here, so it is dimmed)
  await expect(page.locator(".mp-row[data-dm]")).toHaveCount(3);
  // nor can the Default card choose it: two choices, and the 27b disabled with its reason
  await page.getByTestId("models.default.select").click();
  const options = page.getByRole("listbox", { name: "Installed chat models" }).getByRole("option");
  await expect(options).toHaveCount(3);
  await expect(options.filter({ hasText: EMBED.split(":")[0] ?? EMBED })).toHaveCount(0);
  await expect(page.locator('.mp-opt[aria-disabled="true"]')).toHaveCount(1);
});
