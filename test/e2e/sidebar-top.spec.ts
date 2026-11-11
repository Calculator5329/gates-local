/// <reference lib="dom" />
// Journeys: the top of the sidebar. One row in chat (Search at the left, a New
// thread icon button at the right), shortcuts only in tooltips, and the first
// row of the Settings sidebar ("Back to chat") at the same place as Search, so
// the top of the sidebar does not jump between the two views.
import type { Page, TestInfo } from "@playwright/test";
import { expect, test, waitReady } from "./fixtures.ts";

/** Thu 2026-11-12 14:00 in Chicago, as in the screenshot rig. */
const NOW = Date.UTC(2026, 10, 12, 20, 0);
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true };
const TABLET = { viewport: { width: 800, height: 1000 }, isMobile: true, hasTouch: true };

test.use({ seed: "design", seedAt: NOW, timezoneId: "America/Chicago", locale: "en-US" });

type Row = { top: number; height: number; icon: number; text: number };

/** The sidebar's first row: its box, its icon's left edge and its label's left edge. */
function firstRow(page: Page): Promise<Row> {
  return page.locator(".sb .sb-body button").first().evaluate((b) => {
    const r = b.getBoundingClientRect();
    const icon = b.querySelector(".ic")?.getBoundingClientRect().left ?? Number.NaN;
    const text = b.querySelector(".grow")?.getBoundingClientRect().left ?? Number.NaN;
    return { top: r.top, height: r.height, icon, text };
  });
}

function expectSameRow(chat: Row, settings: Row, where: string): void {
  expect(Math.abs(settings.top - chat.top), `${where}: first row top, chat ${chat.top} vs Settings ${settings.top}`).toBeLessThanOrEqual(1);
  expect(Math.abs(settings.icon - chat.icon), `${where}: icon left, chat ${chat.icon} vs Settings ${settings.icon}`).toBeLessThanOrEqual(1);
  expect(Math.abs(settings.text - chat.text), `${where}: text left, chat ${chat.text} vs Settings ${settings.text}`).toBeLessThanOrEqual(1);
}

/** The rows themselves carry no shortcut text; the tooltips do. */
async function expectNoShortcutText(page: Page): Promise<void> {
  const settings = await page.locator(".snav").count();
  const row = settings > 0 ? page.locator(".snav").getByRole("button").first() : page.locator(".sb .sb-body > :first-child");
  await expect(row).not.toContainText(/Ctrl|Esc/);
}

/** The drawer has finished sliding in, so its rows are where they rest. */
const settled = (page: Page) => page.locator(".sb").evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).then(() => undefined));

const shot = (page: Page, info: TestInfo, name: string) => page.screenshot({ path: info.outputPath(`${name}.png`) });

async function desktopOverlay(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const overlay = new EventTarget();
    Object.assign(overlay, { visible: true });
    Object.defineProperty(navigator, "windowControlsOverlay", { value: overlay });
    document.addEventListener("DOMContentLoaded", () => document.documentElement.style.setProperty("--window-controls-width", "138px"));
  });
}

for (const overlay of [false, true]) {
  test(`desktop${overlay ? " app window" : " browser"}: one top row, and Back to chat sits where Search sits`, async ({ page, open }, info) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    if (overlay) await desktopOverlay(page);
    await open();
    await waitReady(page);
    const where = overlay ? "app window" : "browser";
    // the measurement first, so it is what a regression reports
    const first = await firstRow(page);
    await page.keyboard.press("Control+Comma");
    await expect(page.locator(".snav")).toBeVisible();
    const inSettings = await firstRow(page);
    console.log(`ROWS ${where}: chat ${JSON.stringify(first)} settings ${JSON.stringify(inSettings)}`);
    expectSameRow(first, inSettings, where);
    await page.keyboard.press("Escape");
    await expect(page.locator(".snav")).toHaveCount(0);

    const sb = page.locator(".sb");
    const search = sb.getByRole("button", { name: "Search", exact: true });
    const newThread = sb.getByRole("button", { name: "New thread", exact: true });
    await expect(search).toBeVisible();
    await expect(newThread).toBeVisible();
    await expectNoShortcutText(page);

    // one row: the icon button sits on Search's line, at the row's right end, and the list starts under it
    const s = await search.boundingBox();
    const n = await newThread.boundingBox();
    const list = await sb.locator(".sb-list").boundingBox();
    if (!s || !n || !list) throw new Error("missing sidebar boxes");
    expect(Math.abs(n.y + n.height / 2 - (s.y + s.height / 2)), "New thread is on the Search row").toBeLessThanOrEqual(1);
    expect(n.x, "New thread is right of Search").toBeGreaterThanOrEqual(s.x + s.width);
    expect(list.y, "thread list starts under the row").toBeGreaterThanOrEqual(s.y + s.height);
    expect(list.y - (s.y + s.height), "thread list starts right under the row").toBeLessThanOrEqual(12);
    const chat = await firstRow(page);

    // the icon button: label, hover state and keyboard focus ring, tooltip with the shortcut
    await expect(newThread).toHaveClass(/\bibtn\b/);
    const rest = await newThread.evaluate((el) => getComputedStyle(el).backgroundColor);
    await newThread.hover();
    await expect.poll(() => newThread.evaluate((el) => getComputedStyle(el).backgroundColor), { message: "hover state" }).not.toBe(rest);
    await expect(page.locator(".tip.open")).toHaveText("New thread · Ctrl N");
    await shot(page, info, `desktop${overlay ? "-app" : ""}-chat-tip-new`);
    await search.hover();
    await expect(page.locator(".tip.open")).toHaveText("Search threads · Ctrl K");
    await page.mouse.move(900, 600);
    await expect(page.locator(".tip.open")).toHaveCount(0);
    await search.focus();
    await page.keyboard.press("Tab");
    await expect(newThread).toBeFocused();
    await expect(newThread).toHaveCSS("outline-style", "solid");
    await expect(page.locator(".tip.open")).toHaveText("New thread · Ctrl N");
    await newThread.blur();
    await expect(page.locator(".tip.open")).toHaveCount(0);
    await shot(page, info, `desktop${overlay ? "-app" : ""}-chat`);

    // Settings: Back to chat on the same line, icon and text at the same left edges
    await page.keyboard.press("Control+Comma");
    await expect(page.locator(".snav")).toBeVisible();
    const back = page.locator(".snav").getByRole("button", { name: "Back to chat", exact: true });
    await expect(back).toBeVisible();
    await expectNoShortcutText(page);
    expectSameRow(chat, await firstRow(page), where);
    await back.hover();
    await expect(page.locator(".tip.open")).toHaveText("Back to chat · Esc");
    await page.mouse.move(900, 600);
    await expect(page.locator(".tip.open")).toHaveCount(0);
    await expect(back, "hover state clears").toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await shot(page, info, `desktop${overlay ? "-app" : ""}-settings`);
    await back.click();
    await expect(page.locator(".snav")).toHaveCount(0);
    await expect(search).toBeVisible();
  });
}

test("New thread by click and by Ctrl N; search by click and Ctrl K, filtering, Escape, the row holding still", async ({ page, open }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open();
  await waitReady(page);
  const sb = page.locator(".sb");
  const row = sb.locator(".sb-body > :first-child");
  const search = sb.getByRole("button", { name: "Search", exact: true });
  const newThread = sb.getByRole("button", { name: "New thread", exact: true });

  await sb.locator(".sb-row").filter({ hasText: "Fix the backup cron" }).click();
  await expect(page).toHaveURL(/#thread=/);
  await newThread.click();
  await expect(page).not.toHaveURL(/#thread=/);
  await expect(page.locator("#ta")).toBeFocused();
  await sb.locator(".sb-row").filter({ hasText: "Fix the backup cron" }).click();
  await expect(page).toHaveURL(/#thread=/);
  await page.keyboard.press("Control+n");
  await expect(page).not.toHaveURL(/#thread=/);

  const before = await row.boundingBox();
  const field = await search.boundingBox();
  const all = await sb.locator(".sb-row").count();
  expect(all).toBeGreaterThan(1);
  await search.click();
  await expect(page.locator("#searchIn")).toBeFocused();
  expect(await row.boundingBox(), "the row keeps its box when search opens").toEqual(before);
  const input = await sb.locator(".sb-search").boundingBox();
  expect(input?.y, "the field takes Search's place").toBe(field?.y);
  expect(input?.height).toBe(field?.height);
  expect(input?.x).toBe(field?.x);
  await expect(newThread).toBeVisible();
  await page.keyboard.type("backup");
  await expect(sb.locator(".sb-row").filter({ hasNotText: /backup/i })).toHaveCount(0);
  await expect(sb.locator(".sb-row")).not.toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator("#searchIn")).toHaveCount(0);
  await expect(sb.locator(".sb-row")).toHaveCount(all);
  expect(await row.boundingBox(), "the row keeps its box when search closes").toEqual(before);

  await page.keyboard.press("Control+k");
  await expect(page.locator("#searchIn")).toBeFocused();
  expect(await row.boundingBox()).toEqual(before);
  await page.keyboard.press("Escape");
  await expect(search).toBeVisible();
  expect(await row.boundingBox()).toEqual(before);
});

test.describe("phone drawer", () => {
  test.use(PHONE);
  test("44 px touch targets, nothing over the close button", async ({ page, open }, info) => {
    await open();
    await waitReady(page);
    await page.getByRole("button", { name: "Open threads" }).tap();
    const sb = page.locator(".sb");
    await expect(sb.locator(".sb-row").first()).toBeInViewport({ ratio: 1 });
    const search = sb.getByRole("button", { name: "Search", exact: true });
    const newThread = sb.getByRole("button", { name: "New thread", exact: true });
    const close = sb.getByRole("button", { name: "Close threads", exact: true });
    await expectNoShortcutText(page);
    const s = await search.boundingBox();
    const n = await newThread.boundingBox();
    const x = await close.boundingBox();
    if (!s || !n || !x) throw new Error("missing drawer boxes");
    expect(s.height).toBeGreaterThanOrEqual(44);
    expect(n.width).toBeGreaterThanOrEqual(44);
    expect(n.height).toBeGreaterThanOrEqual(44);
    const overlaps = n.x < x.x + x.width && x.x < n.x + n.width && n.y < x.y + x.height && x.y < n.y + n.height;
    expect(overlaps, "New thread clear of the close button").toBe(false);
    expect(n.x + n.width).toBeLessThanOrEqual((await sb.boundingBox())?.width ?? 0);
    await shot(page, info, "phone-chat-drawer");
    await search.tap();
    await expect(page.locator("#searchIn")).toBeFocused();
    expect((await sb.locator(".sb-search").boundingBox())?.height).toBe(s.height);
    await shot(page, info, "phone-chat-drawer-search");
    await page.keyboard.press("Escape");
    await expect(page.locator("#searchIn")).toHaveCount(0);
    await sb.getByRole("button", { name: "Settings" }).tap();
    await expect(page.locator(".set-list")).toBeVisible();
    await expect(page.locator("#app")).not.toHaveClass(/drawer/);
    await settled(page);
    await shot(page, info, "phone-settings");
  });
});

test.describe("tablet drawer", () => {
  test.use(TABLET);
  test("Back to chat sits where Search sits, and the drawer keeps its close button in Settings", async ({ page, open }, info) => {
    await open();
    await waitReady(page);
    const sb = page.locator(".sb");
    await page.getByRole("button", { name: "Open threads" }).tap();
    await expect(sb.locator(".sb-row").first()).toBeInViewport({ ratio: 1 });
    await settled(page);
    const chat = await firstRow(page);
    await sb.getByRole("button", { name: "Close threads", exact: true }).tap();
    await expect(page.locator("#app")).not.toHaveClass(/drawer/);
    await page.keyboard.press("Control+Comma");
    await expect(page.locator(".set")).toBeVisible();
    await page.getByRole("button", { name: "Open threads" }).tap();
    await expect(sb.locator(".snav .sb-act").first()).toBeInViewport({ ratio: 1 });
    await settled(page);
    const settings = await firstRow(page);
    console.log(`ROWS tablet drawer: chat ${JSON.stringify(chat)} settings ${JSON.stringify(settings)}`);
    expectSameRow(chat, settings, "tablet drawer");
    await expect(sb.getByRole("button", { name: "Close threads", exact: true })).toBeVisible();
    const back = sb.getByRole("button", { name: "Back to chat", exact: true });
    expect((await back.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await shot(page, info, "tablet-settings-drawer");
  });
});
