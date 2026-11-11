/// <reference lib="dom" />
// Journeys: the top of the sidebar. One row in chat (an always-there Search
// field at the left, a New thread icon button at the right), and the first row
// of the Settings sidebar ("Back to chat") at the same place as the field, so
// the top of the sidebar does not jump between the two views. The field never
// swaps or moves: rest, pointer over it, focus and typing differ only in fill,
// the Ctrl K hint (pointer on a wide screen only) and the clear button.
import type { Page, TestInfo } from "@playwright/test";
import { expect, test, waitReady } from "./fixtures.ts";

/** Thu 2026-11-12 14:00 in Chicago, as in the screenshot rig. */
const NOW = Date.UTC(2026, 10, 12, 20, 0);
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true };
const TABLET = { viewport: { width: 800, height: 1000 }, isMobile: true, hasTouch: true };

test.use({ seed: "design", seedAt: NOW, timezoneId: "America/Chicago", locale: "en-US" });

type Row = { top: number; height: number; icon: number; text: number };

/** The sidebar's first row (the Search field in chat, Back to chat in Settings): its box, its icon's left edge and its text's left edge. */
function firstRow(page: Page): Promise<Row> {
  return page.locator(".sb .sb-body").locator(".sb-search, .snav .sb-act").first().evaluate((b) => {
    const r = b.getBoundingClientRect();
    const icon = b.querySelector(".ic")?.getBoundingClientRect().left ?? Number.NaN;
    const text = b.querySelector(".grow, input")?.getBoundingClientRect().left ?? Number.NaN;
    return { top: r.top, height: r.height, icon, text };
  });
}

type Field = { x: number; y: number; width: number; height: number; text: number };

/** The Search field's box and the left edge of the text in it. */
function field(page: Page): Promise<Field> {
  return page.locator(".sb .sb-search").evaluate((el) => {
    const r = el.getBoundingClientRect();
    const input = el.querySelector("input");
    if (!input) throw new Error("no input in the Search field");
    const text = input.getBoundingClientRect().left + parseFloat(getComputedStyle(input).paddingLeft);
    return { x: r.x, y: r.y, width: r.width, height: r.height, text };
  });
}

/** The field's fill once its 0.12 s fade has settled; read mid-fade it is a colour between two states. */
const fill = (page: Page) => page.locator(".sb .sb-search").evaluate(async (el) => {
  await Promise.all(el.getAnimations().map((a) => a.finished));
  return getComputedStyle(el).backgroundColor;
});

function expectSameRow(chat: Row, settings: Row, where: string): void {
  expect(Math.abs(settings.top - chat.top), `${where}: first row top, chat ${chat.top} vs Settings ${settings.top}`).toBeLessThanOrEqual(1);
  expect(Math.abs(settings.icon - chat.icon), `${where}: icon left, chat ${chat.icon} vs Settings ${settings.icon}`).toBeLessThanOrEqual(1);
  expect(Math.abs(settings.text - chat.text), `${where}: text left, chat ${chat.text} vs Settings ${settings.text}`).toBeLessThanOrEqual(1);
}

/** At rest the rows show no shortcut text; the tooltips and the field's hover hint do. */
async function expectNoShortcutText(page: Page): Promise<void> {
  const settings = await page.locator(".snav").count();
  const row = settings > 0 ? page.locator(".snav").getByRole("button").first() : page.locator(".sb .sb-body > :first-child");
  await expect(row).not.toContainText(/Ctrl|Esc/, { useInnerText: true });
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
    const search = sb.locator(".sb-search");
    const input = sb.getByRole("textbox", { name: "Search threads", exact: true });
    const newThread = sb.getByRole("button", { name: "New thread", exact: true });
    await expect(search).toBeVisible();
    await expect(input).toHaveAttribute("placeholder", "Search");
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
    // the field has no tooltip: its hover hint carries the shortcut
    await search.hover();
    await expect(search.locator(".sb-kbd")).toBeVisible();
    await expect(search.locator(".sb-kbd")).toHaveText("Ctrl K");
    await page.waitForTimeout(700);
    await expect(page.locator(".tip.open")).toHaveCount(0);
    await page.mouse.move(900, 600);
    await expect(search.locator(".sb-kbd")).toBeHidden();
    await input.focus();
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
    await expect(input).toBeVisible();
  });
}

test("New thread by click and by Ctrl N; search by click and Ctrl K, filtering, Escape, the row holding still", async ({ page, open }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open();
  await waitReady(page);
  const sb = page.locator(".sb");
  const row = sb.locator(".sb-body > :first-child");
  const search = sb.locator(".sb-search");
  const input = page.locator("#searchIn");
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
  const all = await sb.locator(".sb-row").count();
  expect(all).toBeGreaterThan(1);
  await search.click();
  await expect(input).toBeFocused();
  expect(await row.boundingBox(), "the row keeps its box when search is focused").toEqual(before);
  await page.keyboard.type("backup");
  await expect(sb.locator(".sb-row").filter({ hasNotText: /backup/i })).toHaveCount(0);
  await expect(sb.locator(".sb-row")).not.toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(input, "Esc clears the field").toHaveValue("");
  await expect(input, "and leaves it").not.toBeFocused();
  await expect(sb.locator(".sb-row")).toHaveCount(all);
  expect(await row.boundingBox(), "the row keeps its box when search clears").toEqual(before);

  await page.keyboard.press("Control+k");
  await expect(input).toBeFocused();
  expect(await row.boundingBox()).toEqual(before);
  await page.keyboard.press("Escape");
  await expect(input).toBeVisible();
  expect(await row.boundingBox()).toEqual(before);
});

test("the Search field is always there and never moves: rest, pointer, focus, typing; × and Esc clear; a count heading and marked matches", async ({ page, open }, info) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open();
  await waitReady(page);
  const sb = page.locator(".sb");
  const search = sb.locator(".sb-search");
  const input = page.locator("#searchIn");
  const hint = search.locator(".sb-kbd");
  const clear = search.getByRole("button", { name: "Clear search", exact: true });
  await page.mouse.move(900, 600);

  // the measurement first, so a jump is what a regression reports
  const rest = await field(page);
  const restFill = await fill(page);
  await expect(input).toBeVisible();
  await expect(hint).toBeHidden();
  await expect(clear).toHaveCount(0);
  await sb.screenshot({ path: info.outputPath("trim-search-rest.png") });

  await search.hover();
  const hover = await field(page);
  await expect(hint).toBeVisible();
  await expect(search).toHaveCSS("cursor", "text");
  const hoverFill = await fill(page);
  await sb.screenshot({ path: info.outputPath("trim-search-hover.png") });

  await page.keyboard.press("Control+k");
  await expect(input, "Ctrl K focuses the field").toBeFocused();
  await page.mouse.move(900, 600);
  const focused = await field(page);
  await expect(input).toHaveCSS("outline-style", "none");
  await expect(search).toHaveCSS("box-shadow", "none");
  const focusFill = await fill(page);

  await page.keyboard.type("backup");
  const typing = await field(page);
  await expect(clear).toBeVisible();
  await expect(clear).toHaveAttribute("data-tip", "Clear · Esc");
  await search.hover();
  await expect(hint, "the × replaces the hint").toBeHidden();
  await page.mouse.move(900, 600);
  await sb.screenshot({ path: info.outputPath("trim-search-typing.png") });
  console.log(`SEARCH_FIELD ${JSON.stringify({ rest, hover, focused, typing, restFill, hoverFill, focusFill })}`);
  for (const [name, at] of [["hover", hover], ["focus", focused], ["typing", typing]] as const) {
    expect(at, `the field and its text hold still at ${name}`).toEqual(rest);
  }
  expect(hoverFill, "the fill brightens under the pointer").not.toBe(restFill);
  expect(focusFill, "focus keeps the brighter fill").toBe(hoverFill);

  // the list narrows: one heading with the count, the matched words brighter
  const rows = sb.locator(".sb-row");
  await expect(rows.filter({ hasNotText: /backup/i })).toHaveCount(0);
  const n = await rows.count();
  expect(n).toBeGreaterThan(0);
  await expect(sb.locator(".sb-group")).toHaveText([`${n} thread${n === 1 ? "" : "s"}`]);
  const mark = rows.first().locator("mark");
  await expect(mark).toHaveText(/^backup$/i);
  await expect(mark).toHaveCSS("font-weight", "600");
  await expect(rows.first().locator(".t")).toHaveText(/backup/i);

  // × clears and keeps focus
  await clear.click();
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  await expect(clear).toHaveCount(0);
  await expect(sb.locator(".sb-row mark")).toHaveCount(0);
  expect(await field(page)).toEqual(rest);

  // no match keeps its words; Esc clears and leaves the field
  await page.keyboard.type("zzzz no such thread");
  await expect(sb.locator(".sb-empty")).toHaveText("No thread matches.");
  await page.keyboard.press("Escape");
  await expect(input).toHaveValue("");
  await expect(input).not.toBeFocused();
  await expect(sb.locator(".sb-empty")).toHaveCount(0);
  expect(await field(page)).toEqual(rest);
  await page.mouse.move(900, 600); // the × click left the pointer over the field
  expect(await fill(page)).toBe(restFill);
});

test.describe("light theme", () => {
  test.use({ colorScheme: "light" });
  test("the Search field rests on its own quiet fill", async ({ page, open }, info) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open();
    await waitReady(page);
    await page.mouse.move(900, 600);
    const restFill = await fill(page);
    await page.locator(".sb .sb-search").hover();
    expect(await fill(page), "the pointer brightens it in light too").not.toBe(restFill);
    expect(restFill).not.toBe("rgba(0, 0, 0, 0)");
    await page.mouse.move(900, 600);
    await page.locator(".sb").screenshot({ path: info.outputPath("trim-search-light-rest.png") });
  });
});

test.describe("phone drawer", () => {
  test.use(PHONE);
  test("44 px touch targets, nothing over the close button", async ({ page, open }, info) => {
    await open();
    await waitReady(page);
    await page.getByRole("button", { name: "Open threads" }).tap();
    const sb = page.locator(".sb");
    await expect(sb.locator(".sb-row").first()).toBeInViewport({ ratio: 1 });
    // focus goes to New thread, never Close threads (Enter would shut the drawer again); the field would raise the keyboard
    await expect(sb.getByRole("button", { name: "New thread", exact: true }), "opening the drawer focuses New thread").toBeFocused();
    await settled(page);
    const search = sb.locator(".sb-search");
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
    expect(await sb.locator(".sb-search").boundingBox(), "the field holds still when tapped").toEqual(s);
    await expect(sb.locator(".sb-kbd"), "no shortcut hint on touch").toBeHidden();
    await page.keyboard.type("backup");
    const clear = sb.getByRole("button", { name: "Clear search", exact: true });
    await expect(clear).toBeVisible();
    const c = await clear.boundingBox();
    expect(c?.width, "the × is a 44 px target").toBeGreaterThanOrEqual(44);
    expect(c?.height).toBeGreaterThanOrEqual(44);
    expect(await sb.locator(".sb-search").boundingBox(), "the field holds still while typing").toEqual(s);
    await shot(page, info, "phone-chat-drawer-search");
    await clear.tap();
    await expect(page.locator("#searchIn")).toHaveValue("");
    await expect(sb.locator(".sb-kbd")).toBeHidden();
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

test.describe("drawer with a keyboard and pointer", () => {
  test.use({ viewport: { width: 800, height: 1000 } });
  test("opening it focuses the Search field, in Settings Back to chat, never Close threads or the footer", async ({ page, open }) => {
    await open();
    await waitReady(page);
    const sb = page.locator(".sb");
    await page.getByRole("button", { name: "Open threads" }).click();
    await expect(sb.locator(".sb-row").first()).toBeInViewport({ ratio: 1 });
    await expect(page.locator("#searchIn"), "the first thing in the drawer, as the row's Search button was").toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#app"), "one Escape from the empty field closes the drawer").not.toHaveClass(/drawer/);
    await page.keyboard.press("Control+Comma");
    await expect(page.locator(".set")).toBeVisible();
    await page.getByRole("button", { name: "Open threads" }).click();
    await expect(sb.getByRole("button", { name: "Back to chat", exact: true })).toBeFocused();
  });
});
