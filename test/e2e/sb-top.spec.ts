/// <reference lib="dom" />
// Chat row 15, the sidebar top as T3 has it. At rest Search has no box: a
// magnifier and the word, the magnifier in line with the thread names. Under
// the pointer the box fills in at the same place. The row's right side is New
// thread only. The thread list hides its scrollbar and fades only at an edge
// with more threads past it; the wheel still scrolls it, and the rest of the
// app keeps its thin bar. Shots: rest and pointer, dark and light, and the
// list at its top, middle and end, each with the boxes of what it is about.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test, waitReady } from "./fixtures.ts";

const NOW = Date.UTC(2026, 10, 12, 20, 0);
// seven threads in three date groups; a short window makes them run past the list's end
const SHORT = { width: 1280, height: 360 };
test.use({ seed: "design", seedAt: NOW, timezoneId: "America/Chicago", locale: "en-US", video: "off" });

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

const fill = (page: Page) => page.locator(".sb .sb-search").evaluate(async (el) => {
  await Promise.all(el.getAnimations().map((a) => a.finished));
  return getComputedStyle(el).backgroundColor;
});

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

test("row 15: Search rests with no box in line with the threads, New thread alone at the right, and the list fades instead of showing a bar", async ({ page, open }) => {
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
  await page.waitForTimeout(200);
  const middle = await listState(page);
  await shoot(page, "list-middle-dark", marks);
  await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(200);
  const atEnd = await listState(page);
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

test("row 15: when a search narrows the list until it fits, both fades go", async ({ page, open }) => {
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
