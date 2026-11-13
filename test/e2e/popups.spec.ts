/// <reference lib="dom" />
// Models, Usage and Settings are one pop-up shell (settings rows 6 and 26), T3 Code's Settings
// dialog: one box of one size whatever is in it, centred on the window, its content scrolling
// inside, its header one row (title at the left, controls and Close at the right), over a
// backdrop that blurs the whole window.
import type { Locator, Page } from "@playwright/test";
import { expect, test, waitReady } from "./fixtures.ts";

async function box(l: Locator) {
  const b = await l.boundingBox();
  if (b === null) throw new Error("not on screen");
  return b;
}

/** The one box (owner 2026-11-13, row 26): min(100vw - 80px, 1280px) by min(100dvh - 80px, 960px) from 1024 px wide, centred both ways. */
function shellBox(vw: number, vh: number) {
  const width = Math.min(vw - 80, 1280);
  const height = Math.min(vh - 80, 960);
  return { x: (vw - width) / 2, y: (vh - height) / 2, width, height };
}

/** The shell's size and place, centred on the window (not the chat). */
async function expectShape(page: Page, dlg: Locator) {
  const vp = page.viewportSize() ?? { width: 0, height: 0 };
  const b = await box(dlg);
  const want = shellBox(vp.width, vp.height);
  for (const k of ["x", "y", "width", "height"] as const) expect(Math.abs(b[k] - want[k]), `${k} ${b[k]}, the shell's is ${want[k]}`).toBeLessThan(1.5);
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

const footIcon = (page: Page, n: number) => page.locator(".sb-foot .ibtn").nth(n);

/** A footer icon under the dim: clicked where it is drawn, as a person would. */
async function clickUnderDim(page: Page, n: number) {
  const b = await box(footIcon(page, n));
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}

// Guards the owner's ruling (settings row 6): Models is its own pop-up, like T3 Code's dialogs.
test("Models is its own pop-up over the chat: the shell's box, tabs and Close in its header", async ({ page, open }) => {
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
  await expectBackdrop(page);
  await expect(page.locator(".sb #searchIn"), "the sidebar keeps its threads").toBeVisible();
  await expect(page.locator("#ta"), "the chat stays in view under the blur").toBeVisible();
  await expect(bot, "the bot is lit, not the gear").toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".sb-foot .ibtn").first()).toHaveAttribute("aria-pressed", "false");

  // Download and back: the header stays put
  await models.getByRole("tab", { name: "Download" }).click();
  await expect(models.getByRole("tab", { name: "Download" })).toHaveAttribute("aria-selected", "true");
  expect(await box(models)).toEqual(b);
  await page.keyboard.press("Escape");
  await expect(models.getByRole("tab", { name: /Installed/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(models).toHaveCount(0);
  await expect(page.locator("#ta"), "the caret back in the message box").toBeFocused();

  // Settings no longer lists Models, and does not reopen on it
  await page.keyboard.press("Control+Comma");
  await expect(page.locator(".snav")).toBeVisible();
  await expect(page.getByTestId("settings.nav.open-models")).toHaveCount(0);
  await expect(page.locator(".snav .sb-act.on")).toHaveText("General");
  await page.keyboard.press("Escape");

  await bot.click();
  await expect(models).toBeVisible();
  await close.click();
  await expect(models).toHaveCount(0);
});

test.describe("Usage", () => {
  test.use({ seed: "usage", timezoneId: "UTC" });

  test("Usage is the same pop-up: the shell's box, range, chart and Close in its header", async ({ page, open, seededThread }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    const icon = page.locator(".sb-foot .usage");
    await icon.click();
    const usage = page.getByRole("dialog", { name: "Usage" });
    await expect(usage.locator(".us-rows tbody tr").first()).toBeVisible();
    await expectShape(page, usage);
    await expectOneRow(
      usage.getByRole("heading", { name: "Usage", exact: true }),
      usage.getByRole("group", { name: "Range" }),
      usage.locator(".us-ctl").getByRole("group", { name: "Chart" }),
      usage.getByRole("button", { name: "Close", exact: true }),
    );
    await expectBackdrop(page);
    await expect(page.locator(".sb #searchIn"), "the sidebar keeps its threads").toBeVisible();
    await expect(icon).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(usage).toHaveCount(0);
    await expect(icon, "focus back on its icon").toBeFocused();
  });
});

test("Settings is the same pop-up: its sections at its left, the chat and threads in view under the blur", async ({ page, open }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open();
  await waitReady(page);
  await page.keyboard.press("Control+Comma");
  const set = page.getByRole("dialog", { name: "Settings" });
  await expect(set.getByText("Theme", { exact: true })).toBeVisible();
  await expectShape(page, set);
  await expectOneRow(set.getByRole("heading", { name: "Settings", exact: true }), set.getByRole("button", { name: "Close", exact: true }));
  const b = await box(set);
  await expectBackdrop(page);
  await expect(page.locator(".sb #searchIn"), "the sidebar keeps its threads").toBeVisible();
  await expect(page.locator("#ta"), "the chat stays in view under the blur").toBeVisible();
  await expect(page.locator(".sb-foot .ibtn").first(), "the gear is lit").toHaveAttribute("aria-pressed", "true");

  // the sections are inside the pop-up; picking one keeps the box
  const nav = set.locator(".snav");
  await nav.getByTestId("settings.nav.open-tools").click();
  await expect(nav.locator(".sb-act.on")).toHaveText("Tools");
  expect(await box(set)).toEqual(b);
  await page.keyboard.press("Escape");
  await expect(set).toHaveCount(0);
  await expect(page.locator("#ta"), "the caret back in the message box").toBeFocused();
});

// Guards the owner's ruling (2026-11-13, row 26): "a consistent sized pop up for each of the 3 and
// act like settings pop up does on t3 code", and row 25: a footer icon switches straight to its pop-up.
test.describe("one shell for Models, Usage and Settings", () => {
  test.use({ seed: "usage", timezoneId: "UTC", colorScheme: "dark" });

  test("the three are one box at one size and place, at 1280 and 1920; Settings keeps it in every section", async ({ page, open, seededThread }, info) => {
    for (const [vw, vh] of [[1280, 800], [1920, 1080]] as const) {
      await page.setViewportSize({ width: vw, height: vh });
      await open(`#thread=${seededThread ?? ""}`);
      await waitReady(page);
      const boxes: Record<string, Awaited<ReturnType<typeof box>>> = {};

      await footIcon(page, 1).click();
      const models = page.getByRole("dialog", { name: "Models" });
      await expect(models.getByText("Default for new chats")).toBeVisible();
      await page.mouse.move(0, 0);
      if (vw === 1280) await page.screenshot({ path: info.outputPath("shell-models.png"), animations: "disabled" });
      boxes.models = await box(models);
      const heads = [(await box(models.locator(".dlg-head"))).height];
      await page.keyboard.press("Escape");
      await expect(models).toHaveCount(0);

      await page.locator(".sb-foot .usage").click();
      const usage = page.getByRole("dialog", { name: "Usage" });
      await expect(usage.locator(".us-rows tbody tr").first()).toBeVisible();
      await page.mouse.move(0, 0);
      if (vw === 1280) await page.screenshot({ path: info.outputPath("shell-usage.png"), animations: "disabled" });
      boxes.usage = await box(usage);
      heads.push((await box(usage.locator(".dlg-head"))).height);
      await page.keyboard.press("Escape");
      await expect(usage).toHaveCount(0);

      await page.keyboard.press("Control+Comma");
      const set = page.getByRole("dialog", { name: "Settings" });
      await expect(set.getByText("Theme", { exact: true })).toBeVisible();
      await page.mouse.move(0, 0);
      if (vw === 1280) await page.screenshot({ path: info.outputPath("shell-settings.png"), animations: "disabled" });
      boxes.settings = await box(set);
      // opened from the keyboard the box has focus: no ring round it (main drew one)
      await expect(set).toHaveCSS("outline-style", "none");
      heads.push((await box(set.locator(".dlg-head"))).height);
      expect(heads, "each header is one 48 px row").toEqual([48, 48, 48]);
      for (const [name, b] of Object.entries(boxes)) {
        const want = shellBox(vw, vh);
        for (const k of ["x", "y", "width", "height"] as const) expect(Math.abs(b[k] - want[k]), `${name} ${k} at ${vw}: ${b[k]}, the shell's is ${want[k]}`).toBeLessThan(1.5);
      }
      // every section in the same box
      const sections = set.locator(".snav .sb-act");
      for (let i = 0; i < await sections.count(); i++) {
        await sections.nth(i).click();
        await expect(sections.nth(i)).toHaveClass(/\bon\b/);
        expect(await box(set), `Settings › ${await sections.nth(i).innerText()} at ${vw}`).toEqual(boxes.settings);
      }
      await page.keyboard.press("Escape");
      await expect(set).toHaveCount(0);
    }
  });

  test("a long Usage list scrolls inside the box, which stays in the window", async ({ page, open, seededThread }) => {
    await page.setViewportSize({ width: 1280, height: 560 });
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    await page.locator(".sb-foot .usage").click();
    const usage = page.getByRole("dialog", { name: "Usage" });
    await expect(usage.locator(".us-rows tbody tr").first()).toBeVisible();
    await expectShape(page, usage);
    const body = usage.locator(".dlg-body");
    expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight), "more than fits: the body scrolls").toBe(true);
    const before = await box(usage);
    await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(usage.locator(".us-rows tbody tr").last()).toBeInViewport();
    expect(await box(usage), "the box does not move or grow").toEqual(before);
    await expect(usage.getByRole("button", { name: "Close", exact: true }), "the header stays in view").toBeInViewport();
  });

  test("Esc and a click on the padding close; a press in the box released on the padding does not", async ({ page, open }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open();
    await waitReady(page);
    await page.keyboard.press("Control+Comma");
    const set = page.getByRole("dialog", { name: "Settings" });
    await expect(set.getByText("Theme", { exact: true })).toBeVisible();
    // pressed on the title, released on the padding
    const t = await box(set.getByRole("heading", { name: "Settings", exact: true }));
    await page.mouse.move(t.x + 4, t.y + t.height / 2);
    await page.mouse.down();
    await page.mouse.move(640, 16, { steps: 4 });
    await page.mouse.up();
    await expect(set, "a drag that ends on the padding keeps it open").toBeVisible();
    await page.mouse.click(640, 16);
    await expect(set).toHaveCount(0);
    await page.keyboard.press("Control+Comma");
    await expect(set).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(set).toHaveCount(0);
  });

  test("with one pop-up open, a footer icon switches straight to its own, and its own icon closes it", async ({ page, open, seededThread }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    await page.keyboard.press("Control+Comma");
    const set = page.getByRole("dialog", { name: "Settings" });
    const usage = page.getByRole("dialog", { name: "Usage" });
    const models = page.getByRole("dialog", { name: "Models" });
    await expect(set).toBeVisible();
    await clickUnderDim(page, 2);
    await expect(usage).toBeVisible();
    await expect(set).toHaveCount(0);
    await expect(page.locator(".sb-foot .usage")).toHaveAttribute("aria-pressed", "true");
    await clickUnderDim(page, 1);
    await expect(models).toBeVisible();
    await expect(usage).toHaveCount(0);
    await clickUnderDim(page, 0);
    await expect(set).toBeVisible();
    await expect(models).toHaveCount(0);
    await clickUnderDim(page, 0);
    await expect(set, "the lit icon closes its own").toHaveCount(0);
    await expect(page.locator(".dlg-dim")).toHaveCount(0);
  });

  // Settings row 27 (release read 2026-11-13): Ctrl+, over Usage opened Settings with Usage still up.
  test("Ctrl+, over Usage swaps it for Settings: one pop-up, and Esc leaves none", async ({ page, open, seededThread }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    const usage = page.getByRole("dialog", { name: "Usage" });
    const set = page.getByRole("dialog", { name: "Settings" });
    await page.locator(".sb-foot .usage").click();
    await expect(usage).toBeVisible();
    await page.keyboard.press("Control+Comma");
    await expect(set).toBeVisible();
    await expect(usage, "opening one pop-up closes the other").toHaveCount(0);
    await expect(page.locator(".dlg")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.locator(".dlg")).toHaveCount(0);
    await expect(page.locator(".dlg-dim")).toHaveCount(0);
  });

  test("a narrow window: the box 24 px in, Usage's header still one row, Settings' sections an icon rail named in tips", async ({ page, open, seededThread }, info) => {
    await page.setViewportSize({ width: 720, height: 700 });
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    // under 1024 px the footer is in the threads drawer
    await page.locator("#menuBtn").click();
    await page.locator(".sb-foot .usage").click();
    const usage = page.getByRole("dialog", { name: "Usage" });
    await expect(usage.locator(".us-rows tbody tr").first()).toBeVisible();
    expect(await box(usage)).toEqual({ x: 24, y: 24, width: 672, height: 652 });
    expect((await box(usage.locator(".dlg-head"))).height).toBe(48);
    const close = await box(usage.getByRole("button", { name: "Close", exact: true }));
    expect(close.x + close.width, "Close inside the box").toBeLessThanOrEqual(24 + 672);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: info.outputPath("shell-usage-720.png"), animations: "disabled" });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+Comma");
    const set = page.getByRole("dialog", { name: "Settings" });
    await expect(set.getByText("Theme", { exact: true })).toBeVisible();
    expect((await box(set.locator(".dlg-nav"))).width).toBe(56);
    const tools = set.getByTestId("settings.nav.open-tools");
    await tools.hover();
    await expect(page.locator("#tip.open")).toHaveText("Tools");
    await page.mouse.move(0, 0);
    await page.screenshot({ path: info.outputPath("shell-settings-720.png"), animations: "disabled" });
  });

  test("on a phone Usage is the whole window", async ({ page, open, seededThread }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    await page.locator("#menuBtn").click();
    await page.locator(".sb-foot .usage").click();
    const usage = page.getByRole("dialog", { name: "Usage" });
    await expect(usage.locator(".us-rows tbody tr").first()).toBeVisible();
    expect(await box(usage)).toEqual({ x: 0, y: 0, width: 390, height: 844 });
    await page.keyboard.press("Escape");
    await expect(usage).toHaveCount(0);
  });
});
