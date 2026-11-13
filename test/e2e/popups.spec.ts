/// <reference lib="dom" />
// Models is a pop-up of its own (settings row 6), T3's dialog: centred on the window, about
// two-thirds of its width, as tall as what is in it, its header one row (title at the left,
// controls and Close at the right), over a backdrop that blurs the whole window.
import type { Locator, Page } from "@playwright/test";
import { expect, test, waitReady } from "./fixtures.ts";

async function box(l: Locator) {
  const b = await l.boundingBox();
  if (b === null) throw new Error("not on screen");
  return b;
}

/** Two-thirds of the window wide, centred on the window (not the chat), its top near the window's top. */
async function expectShape(page: Page, dlg: Locator) {
  const vw = page.viewportSize()?.width ?? 0;
  const b = await box(dlg);
  expect(Math.abs(b.width - (vw * 2) / 3), `width ${b.width} in a ${vw} window`).toBeLessThan(4);
  expect(Math.abs(b.x + b.width / 2 - vw / 2), "centred on the window, not the chat").toBeLessThan(2);
  expect(b.y, "top near the window's top").toBeLessThan(72);
}

/** Title, controls and Close share one row. */
async function expectOneRow(title: Locator, ...others: Locator[]) {
  const t = await box(title);
  for (const o of others) {
    const b = await box(o);
    expect(Math.abs(t.y + t.height / 2 - (b.y + b.height / 2)), "one header row").toBeLessThan(6);
  }
}

/** The backdrop covers and blurs the whole window, sidebar included. */
async function expectBackdrop(page: Page) {
  const vp = page.viewportSize();
  const dim = page.locator(".dlg-dim");
  expect(await box(dim)).toEqual({ x: 0, y: 0, width: vp?.width, height: vp?.height });
  await expect(dim).toHaveCSS("backdrop-filter", "blur(4px)");
}

// Guards the owner's ruling (settings row 6): Models is its own pop-up, like T3 Code's dialogs.
test("Models is its own pop-up over the chat: two-thirds wide, as tall as its list, tabs and Close in its header", async ({ page, open }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open();
  await waitReady(page);
  const bot = page.locator(".sb-foot .ibtn").nth(1);
  await bot.click();
  const models = page.getByRole("dialog", { name: "Models" });
  await expect(models).toBeVisible();
  await expect(models.getByText("Default for new chats")).toBeVisible();
  await expectShape(page, models);
  const close = models.getByRole("button", { name: "Close", exact: true });
  await expectOneRow(models.getByRole("heading", { name: "Models" }), models.getByRole("tab", { name: /Installed/ }), close);
  const b = await box(models);
  expect(b.y + b.height, "a short list: no window-tall box").toBeLessThan(800 - 120);
  await expectBackdrop(page);
  await expect(page.locator(".sb #searchIn"), "the sidebar keeps its threads").toBeVisible();
  await expect(page.locator("#ta"), "the chat stays in view under the blur").toBeVisible();
  await expect(bot, "the bot is lit, not the gear").toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".sb-foot .ibtn").first()).toHaveAttribute("aria-pressed", "false");

  // Download and back: the header stays put
  await models.getByRole("tab", { name: "Download" }).click();
  await expect(models.getByRole("tab", { name: "Download" })).toHaveAttribute("aria-selected", "true");
  expect((await box(models)).y).toBe(b.y);
  await page.keyboard.press("Escape");
  await expect(models.getByRole("tab", { name: /Installed/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(models).toHaveCount(0);
  await expect(page.locator("#ta"), "the caret back in the message box").toBeFocused();

  // Settings no longer lists Models, and does not reopen on it
  await page.keyboard.press("Control+Comma");
  await expect(page.locator(".snav")).toBeVisible();
  await expect(page.locator(".snav").getByRole("button", { name: "Models", exact: true })).toHaveCount(0);
  await expect(page.locator(".snav .sb-act.on")).toHaveText("General");
  await page.keyboard.press("Escape");

  await bot.click();
  await expect(models).toBeVisible();
  await close.click();
  await expect(models).toHaveCount(0);
});
