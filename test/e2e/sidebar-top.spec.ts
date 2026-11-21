/// <reference lib="dom" />
// Journeys: the top of the sidebar. One row in chat (an always-there Search
// field at the left, a New thread icon button at the right), and the first row
// of the Settings sidebar ("Back to chat") at the same place as the field, so
// the top of the sidebar does not jump between the two views. The field never
// swaps or moves: rest, pointer over it, focus and typing differ only in fill,
// the Ctrl K hint (pointer on a wide screen only) and the clear button. In a
// short window the thread list fades at an edge instead of showing a bar.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test, waitReady } from "./fixtures.ts";
import { holds, painted } from "./waits.ts";

/** Thu 2026-11-12 14:00 in Chicago, as in the screenshot rig. */
const NOW = Date.UTC(2026, 10, 12, 20, 0);
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true };
const TABLET = { viewport: { width: 800, height: 1000 }, isMobile: true, hasTouch: true };

test.use({ seed: "design", seedAt: NOW, olderOpen: true, timezoneId: "America/Chicago", locale: "en-US" });

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
    const input = page.getByTestId("sidebar.search.input");
    const newThread = page.getByTestId("sidebar.top.new-thread");
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
    // New thread's tip goes, and none comes up for the field through the tooltip's delay and past it
    await expect(page.locator(".tip.open")).toHaveCount(0);
    await holds(page, 700, () => page.locator(".tip.open").count(), 0, { message: "a tooltip on the search field" });
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

    // Settings is a pop-up: the sidebar under it keeps Search on the same row; Close names Esc
    await page.keyboard.press("Control+Comma");
    await expect(page.locator(".snav")).toBeVisible();
    const close = page.getByRole("dialog", { name: "Settings" }).getByTestId("ui.dialog.close");
    await expect(close).toBeVisible();
    await expectNoShortcutText(page);
    expectSameRow(chat, await firstRow(page), where);
    await close.hover();
    await expect(page.locator(".tip.open")).toHaveText("Close · Esc");
    await page.mouse.move(900, 600);
    await expect(page.locator(".tip.open")).toHaveCount(0);
    await shot(page, info, `desktop${overlay ? "-app" : ""}-settings`);
    await close.click();
    await expect(page.locator(".snav")).toHaveCount(0);
    await expect(input).toBeVisible();
  });
}

test("New thread by click and by Ctrl N; search by click and Ctrl K, filtering, Escape, the row holding still", async ({ page, open }) => {
  // the seed is dated NOW: the page reads the same day, so the list never regroups as NOW ages
  await page.clock.setFixedTime(NOW);
  await page.setViewportSize({ width: 1280, height: 800 });
  await open();
  await waitReady(page);
  const sb = page.locator(".sb");
  const row = sb.locator(".sb-body > :first-child");
  const search = sb.locator(".sb-search");
  const input = page.locator("#searchIn");
  const newThread = page.getByTestId("sidebar.top.new-thread");

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
  const clear = page.getByTestId("sidebar.search.clear");
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
  expect(restFill, "no box at rest").toBe("rgba(0, 0, 0, 0)");
  expect(hoverFill, "the box fills in under the pointer").not.toBe(restFill);
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
  test("the Search field rests with no box and fills in under the pointer", async ({ page, open }, info) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open();
    await waitReady(page);
    await page.mouse.move(900, 600);
    const restFill = await fill(page);
    await page.locator(".sb .sb-search").hover();
    expect(await fill(page), "the pointer brightens it in light too").not.toBe(restFill);
    expect(restFill, "no box at rest").toBe("rgba(0, 0, 0, 0)");
    await page.mouse.move(900, 600);
    await page.locator(".sb").screenshot({ path: info.outputPath("trim-search-light-rest.png") });
  });
});

test.describe("phone drawer", () => {
  test.use(PHONE);
  test("44 px touch targets, nothing over the close button", async ({ page, open }, info) => {
    await open();
    await waitReady(page);
    await page.getByTestId("chat.header.open-threads").tap();
    const sb = page.locator(".sb");
    await expect(sb.locator(".sb-row").first()).toBeInViewport({ ratio: 1 });
    // focus goes to New thread, never Close threads (Enter would shut the drawer again); the field would raise the keyboard
    await expect(page.getByTestId("sidebar.top.new-thread"), "opening the drawer focuses New thread").toBeFocused();
    await settled(page);
    const search = sb.locator(".sb-search");
    const newThread = page.getByTestId("sidebar.top.new-thread");
    const close = page.getByTestId("sidebar.drawer.close");
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
    const clear = page.getByTestId("sidebar.search.clear");
    await expect(clear).toBeVisible();
    const c = await clear.boundingBox();
    expect(c?.width, "the × is a 44 px target").toBeGreaterThanOrEqual(44);
    expect(c?.height).toBeGreaterThanOrEqual(44);
    expect(await sb.locator(".sb-search").boundingBox(), "the field holds still while typing").toEqual(s);
    await shot(page, info, "phone-chat-drawer-search");
    await clear.tap();
    await expect(page.locator("#searchIn")).toHaveValue("");
    await expect(sb.locator(".sb-kbd")).toBeHidden();
    await page.getByTestId("sidebar.foot.settings").tap();
    await expect(page.locator(".set-list")).toBeVisible();
    await expect(page.locator("#app")).not.toHaveClass(/drawer/);
    await settled(page);
    await shot(page, info, "phone-settings");
  });
});

test.describe("tablet drawer", () => {
  test.use(TABLET);
  test("the drawer keeps its close button, and Settings is a pop-up with its sections and Close at touch size", async ({ page, open }, info) => {
    await open();
    await waitReady(page);
    const sb = page.locator(".sb");
    await page.getByTestId("chat.header.open-threads").tap();
    await expect(sb.locator(".sb-row").first()).toBeInViewport({ ratio: 1 });
    await settled(page);
    await expect(page.getByTestId("sidebar.drawer.close")).toBeVisible();
    await page.getByTestId("sidebar.drawer.close").tap();
    await expect(page.locator("#app")).not.toHaveClass(/drawer/);
    // wider than a phone Settings is a pop-up: its sections are inside it, not in the drawer
    await page.keyboard.press("Control+Comma");
    const set = page.getByRole("dialog", { name: "Settings" });
    await expect(set.locator(".snav .sb-act").first()).toBeInViewport({ ratio: 1 });
    expect((await set.locator(".snav .sb-act").first().boundingBox())?.height).toBeGreaterThanOrEqual(44);
    expect((await set.getByTestId("ui.dialog.close").boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await shot(page, info, "tablet-settings-drawer");
  });
});

test.describe("drawer with a keyboard and pointer", () => {
  test.use({ viewport: { width: 800, height: 1000 } });
  test("opening it focuses the Search field, never Close threads or the footer; Settings takes focus into its pop-up", async ({ page, open }) => {
    await open();
    await waitReady(page);
    const sb = page.locator(".sb");
    await page.getByTestId("chat.header.open-threads").click();
    await expect(sb.locator(".sb-row").first()).toBeInViewport({ ratio: 1 });
    await expect(page.locator("#searchIn"), "the first thing in the drawer, as the row's Search button was").toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#app"), "one Escape from the empty field closes the drawer").not.toHaveClass(/drawer/);
    await page.keyboard.press("Control+Comma");
    await expect(page.locator(".set")).toBeVisible();
    await expect(page.locator(".dlg")).toBeFocused();
  });
});

// The sidebar top as T3 has it, in a short window. At rest Search has no box: a magnifier and the
// word, the magnifier in line with the thread names. Under the pointer the box fills in at the same
// place. The row's right side is New thread only. The thread list hides its scrollbar and fades only
// at an edge with more threads past it; the wheel still scrolls it, and the rest of the app keeps
// its thin bar. Shots: rest and pointer, dark and light, and the list at its top, middle and end,
// each with the boxes of what it is about.

// seven threads in three date groups; a short window makes them run past the list's end
const SHORT = { width: 1280, height: 360 };

/** A screenshot and the boxes of the things it is about, for the report's highlights. */
async function shoot(page: Page, name: string, marks: Record<string, Locator>): Promise<void> {
  const file = test.info().outputPath(`${name}.png`);
  mkdirSync(path.dirname(file), { recursive: true });
  const boxes: Record<string, unknown> = {};
  for (const [k, l] of Object.entries(marks)) boxes[k] = (await l.count()) > 0 ? await l.first().boundingBox() : null;
  await page.screenshot({ path: file, animations: "disabled" });
  writeFileSync(test.info().outputPath(`${name}.json`), JSON.stringify(boxes));
}

async function theme(page: Page, scheme: "dark" | "light"): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
}

/** How the list scrolls and fades: its bar's width, its scroll position and the fade at each edge. */
const listState = (page: Page) => page.locator(".sb .sb-list").evaluate((el: HTMLElement) => {
  const s = getComputedStyle(el);
  return {
    bar: el.offsetWidth - el.clientWidth,
    scrollbarWidth: s.scrollbarWidth,
    mask: s.maskImage || s.getPropertyValue("-webkit-mask-image"),
    top: el.scrollTop,
    overflow: el.scrollHeight - el.clientHeight,
    fadeTop: parseFloat(s.getPropertyValue("--fade-top") || "0"),
    fadeEnd: parseFloat(s.getPropertyValue("--fade-end") || "0"),
  };
});

/** The list once its scroll and its fades have come to rest: the same reading either side of a drawn frame. */
async function restingList(page: Page) {
  await expect.poll(async () => {
    const was = JSON.stringify(await listState(page));
    await painted(page);
    return JSON.stringify(await listState(page)) === was;
  }, { message: "the list's scroll and fades came to rest" }).toBe(true);
  return listState(page);
}

test.describe("a short window", () => {
  // why: the list's height depends on how many day headings the seed falls under, and the seed is
  // dated NOW. With the real date, the test went red once NOW was over a week old (one "Older" heading).
  test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(NOW); });

  // Guards the owner's ruling: the sidebar top as T3 Code has it.
  test("Search rests with no box in line with the threads, New thread alone at the right, and the list fades instead of showing a bar", async ({ page, open }) => {
    await page.setViewportSize(SHORT);
    await open(); await waitReady(page);
    const sb = page.locator(".sb");
    const search = sb.locator(".sb-search");
    const list = sb.locator(".sb-list");
    await expect(list.locator(".sb-row").first()).toBeVisible();
    const marks = { search, tools: sb.locator(".sb-tools"), list };

    // every shot first, so a red run still shows each state
    const fills: Record<string, [string, string]> = {};
    for (const scheme of ["dark", "light"] as const) {
      await theme(page, scheme);
      await page.mouse.move(900, 300);
      await shoot(page, `top-rest-${scheme}`, marks);
      const rest = await fill(page);
      await search.hover();
      await shoot(page, `top-hover-${scheme}`, marks);
      fills[scheme] = [rest, await fill(page)];
      await page.mouse.move(900, 300);
    }
    await theme(page, "dark");
    const box = (await list.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const atTop = await listState(page);
    await shoot(page, "list-top-dark", marks);
    // less than the overflow, so the list stops between its ends
    await page.mouse.wheel(0, 40);
    await expect.poll(async () => (await listState(page)).top).toBeGreaterThan(0);
    const middle = await restingList(page);
    await shoot(page, "list-middle-dark", marks);
    await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const atEnd = await restingList(page);
    await shoot(page, "list-end-dark", marks);
    await theme(page, "light");
    await shoot(page, "list-end-light", marks);
    await theme(page, "dark");

    // Search: no box at rest, a box under the pointer, in both themes
    for (const [scheme, [rest, hover]] of Object.entries(fills)) {
      expect(rest, `${scheme}: no box at rest`).toBe("rgba(0, 0, 0, 0)");
      expect(hover, `${scheme}: the box fills in under the pointer`).not.toBe(rest);
    }
    // the magnifier lines up with the thread names
    const icon = await search.locator(".ic").evaluate((el) => el.getBoundingClientRect().left);
    const name = await list.locator(".sb-row .t").first().evaluate((el) => el.getBoundingClientRect().left);
    expect(Math.abs(icon - name), `magnifier ${icon} vs thread name ${name}`).toBeLessThanOrEqual(1);
    // the right side holds New thread and nothing else
    const right = sb.locator(".sb-top > :not(.sb-search)").getByRole("button");
    await expect(right).toHaveCount(1);
    await expect(right).toHaveAccessibleName("New thread");

    // the list: no bar, a fade only where more threads run past the edge, the wheel still scrolls
    expect(atTop.overflow, "the seed overflows the list at this height").toBeGreaterThan(60);
    expect(atTop.scrollbarWidth).toBe("none");
    expect(atTop.bar, "the list takes no width for a bar").toBe(0);
    expect(atTop.mask, "the list fades at its edges").toContain("gradient");
    expect(atTop.fadeTop, "nothing above at the top: no top fade").toBe(0);
    expect(atTop.fadeEnd, "more threads below at the top").toBeGreaterThan(0);
    expect(middle.top, "the wheel scrolls the list").toBeGreaterThan(0);
    expect(middle.fadeTop).toBeGreaterThan(0);
    expect(middle.fadeEnd).toBeGreaterThan(0);
    expect(atEnd.fadeTop).toBeGreaterThan(0);
    expect(atEnd.fadeEnd, "nothing below at the end: no bottom fade").toBe(0);
    // the rest of the app keeps its thin bar
    expect(await page.locator(".tl, .draft").first().evaluate((el) => getComputedStyle(el).scrollbarWidth)).toBe("thin");
  });

  // Guards the owner's ruling: the list fades only at an edge with more threads past it.
  test("when a search narrows the list until it fits, both fades go", async ({ page, open }) => {
    await page.setViewportSize(SHORT);
    await open(); await waitReady(page);
    const rows = page.locator(".sb .sb-list .sb-row");
    await expect(rows.first()).toBeVisible();
    expect((await listState(page)).fadeEnd, "the full list runs past its end").toBeGreaterThan(0);
    const title = (await rows.first().locator(".t").innerText()).trim();
    await page.locator("#searchIn").fill(title);
    await expect(rows).not.toHaveCount(0);
    await expect.poll(async () => (await listState(page)).overflow).toBeLessThanOrEqual(0);
    const s = await listState(page);
    expect(s.fadeTop).toBe(0);
    expect(s.fadeEnd, "a list that fits has no fade").toBe(0);
  });
});
