// The Usage pop-up (Usage.tsx, Panel.tsx) and the screens over the chat: the
// footer icons are toggles, Usage lies over the chat on a dim layer, Settings
// covers the chat area while the chat stays mounted under it, and closing
// either gives the chat back as it was.
import type { Locator, Page } from "@playwright/test";
import { burst, transitionMetrics } from "./flicker-probe.ts";
import { expect, test, waitReady } from "./fixtures.ts";

const usageIcon = (page: Page) => page.locator(".sb-foot .usage");
// the footer icons by their label's first word: Settings and Models add a state after it
const settingsIcon = (page: Page) => page.locator('.sb-foot button[aria-label^="Settings"]');
const modelsIcon = (page: Page) => page.locator('.sb-foot button[aria-label^="Models"]');
/** A click where the icon sits: under an open pop-up that is the dim layer, which does what the icon does. */
async function clickSpot(page: Page, icon: Locator): Promise<void> {
  const box = (await icon.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
const dialog = (page: Page) => page.getByRole("dialog", { name: "Usage" });
/** A Range button, by its value: 24h, 7d, 30d, all. */
const range = (page: Page, value: string) => dialog(page).getByTestId(`usage.option.${value}`);
/** Where each box of the pop-up sits, to show that hovering and arrows move nothing. */
const boxes = (page: Page) => Promise.all([".dlg", ".us-nums", ".us-chart", ".us-rows"].map(async (s) => page.locator(s).boundingBox()));

interface FrameWindow extends Window { usageFrames?: string[] }

/** Record, every animation frame, whether the pop-up is absent, complete, or showing placeholders. */
async function watchPanel(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const w = window as FrameWindow;
    w.usageFrames = [];
    const tick = () => {
      const p = document.querySelector(".dlg");
      w.usageFrames?.push(p === null ? "none" : p.querySelector(".us-ph") !== null ? "placeholder" : p.querySelector(".us-nums") !== null ? "complete" : "empty");
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return () => page.evaluate(() => (window as FrameWindow).usageFrames ?? []);
}

const atBottom = (tl: Locator) => tl.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

test.describe("a week of three models", () => {
  test.use({ seed: "usage", timezoneId: "UTC", colorScheme: "dark" });

  // Guards the owner's rulings on Usage: a pop-up from the footer icon, over the chat, complete on its first frame;
  // and his pick of 2026-11-20 (layout A): bars per day with dates, the day beside its column, speed as a range.
  test("opens complete from the footer over the chat; day bars, dates, hover and arrows, speed range; Esc closes", async ({ page, open, seededThread }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    await expect(usageIcon(page)).toHaveAttribute("aria-pressed", "false");
    const frames = await watchPanel(page);
    await usageIcon(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect(usageIcon(page)).toHaveAttribute("aria-pressed", "true");
    expect((await frames()).filter((f) => f !== "none" && f !== "complete"), "every frame of the pop-up is complete").toEqual([]);
    // Guards the owner's ruling (2026-11-13): an X in the pop-up's top right corner closes it; a model's row has no bar under its name.
    // Close is in the header row, as in Models and Settings.
    const x = dialog(page).getByTestId("ui.dialog.close");
    await expect(x).toBeVisible();
    const [xb, db] = [(await x.boundingBox())!, (await dialog(page).boundingBox())!];
    expect(db.x + db.width - (xb.x + xb.width), "Close is at the right edge").toBeLessThan(56);
    expect(xb.y - db.y, "Close is on the top row").toBeLessThan(40);
    await expect(page.locator(".us-share")).toHaveCount(0);
    await x.click();
    await expect(dialog(page)).toHaveCount(0);
    await usageIcon(page).click();
    await expect(dialog(page)).toBeVisible();
    // over the whole window: the dim layer, and the chat still there under it, inert
    await expect(page.locator(".dlg-dim")).toBeVisible();
    await expect(page.locator(".turn").first()).toBeVisible();
    expect(await page.locator("#app").evaluate((d) => (d as HTMLElement).inert)).toBe(true);

    await expect(range(page, "7d")).toHaveAttribute("aria-pressed", "true");
    const rows = page.locator(".us-rows tbody tr");
    await expect(rows).toHaveCount(3);
    // one column a day, each day's models stacked in it; dates under the plot and token figures beside it
    const cols = page.locator(".us-col");
    await expect(cols).toHaveCount(7);
    expect(await page.locator(".us-col i").count(), "a segment per model per day used").toBe(3 + 7 + 4);
    const dates = page.locator(".us-xs .us-x");
    await expect(dates).toHaveCount(4);
    // a date is one line under the plot (a page-wide .first rule once drew it as a full-width block)
    for (const d of await dates.all()) expect((await d.boundingBox())!.height).toBeLessThan(20);
    expect(await page.locator(".us-gl").count()).toBeGreaterThanOrEqual(2);
    // no Tokens / Speed switch: the range is the only control beside Close
    await expect(dialog(page).locator(".us-ctl [role=group]")).toHaveCount(1);
    await expect(dialog(page).getByTestId("usage.option.speed")).toHaveCount(0);
    await expect(page.locator("#us-at")).toHaveCount(0);

    // the pointer on a day: a readout beside its column names the day; the table and every box stay put
    const readout = page.locator(".us-read");
    const live = page.locator("#us-read");
    const rangeRows = await rows.allInnerTexts();
    const still = await boxes(page);
    await expect(readout).toHaveCount(0);
    const col = (await cols.nth(3).boundingBox())!;
    await page.mouse.move(col.x + col.width / 2, col.y + col.height / 2);
    await expect(readout).toBeVisible();
    await expect(cols.nth(3)).toHaveClass(/\bon\b/);
    const hovered = await readout.innerText();
    expect(hovered).toMatch(/\d/);
    const rb = (await readout.boundingBox())!;
    expect(rb.x, "the readout sits right of a column in the first half").toBeGreaterThanOrEqual(col.x + col.width);
    expect(await rows.allInnerTexts()).toEqual(rangeRows);
    expect(await boxes(page)).toEqual(still);
    await page.mouse.move(col.x + col.width / 2, col.y - 80);
    await expect(readout).toHaveCount(0);

    // arrows from the keyboard: the first press is the last day, then back one at a time; the table stays
    const chart = page.getByTestId("usage.chart.plot");
    await chart.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(cols.nth(6)).toHaveClass(/\bon\b/);
    const today = (await readout.textContent())!;
    await expect(live).not.toHaveText("");
    const last = (await cols.nth(6).boundingBox())!;
    expect((await readout.boundingBox())!.x + (await readout.boundingBox())!.width, "the readout flips left of the last column").toBeLessThanOrEqual(last.x);
    await page.keyboard.press("ArrowLeft");
    await expect(readout).not.toHaveText(today);
    await page.keyboard.press("End");
    await expect(readout).toHaveText(today);
    expect(await rows.allInnerTexts()).toEqual(rangeRows);
    expect(await boxes(page)).toEqual(still);

    // speed is a range in the table: the model with a slow day reads slowest–fastest, the others one figure
    const speeds = await rows.locator("td:nth-child(4)").allInnerTexts();
    expect(speeds.filter((s) => /^\d+–\d+$/.test(s)), "one model's hours are far apart").toHaveLength(1);
    expect(speeds.filter((s) => /^\d+$/.test(s))).toHaveLength(2);
    await expect(rows.locator(".us-trk s")).toHaveCount(3);
    await expect(rows.first().locator("td:nth-child(4)")).not.toHaveAttribute("data-tip");

    // ranges: each one re-reads nothing and changes the dates; the choice is remembered
    // All starts at the first day with usage, which here is the week's first day: each range differs from the one before
    const firstDate = dates.first();
    const span = await firstDate.innerText();
    let before = span;
    for (const name of ["24h", "30d", "all"]) {
      await range(page, name).click();
      await expect(range(page, name)).toHaveAttribute("aria-pressed", "true");
      await expect(firstDate).not.toHaveText(before);
      before = await firstDate.innerText();
    }
    await expect(firstDate).toHaveText(span);
    await range(page, "30d").click();
    await expect(cols).toHaveCount(30);
    await page.mouse.move(0, 0);
    await dialog(page).screenshot({ path: testInfo.outputPath("usage-30d-rest.png"), animations: "disabled" });
    const recent = (await cols.nth(26).boundingBox())!;
    await page.mouse.move(recent.x + recent.width / 2, recent.y + recent.height - 4);
    await expect(readout).toBeVisible();
    await dialog(page).screenshot({ path: testInfo.outputPath("usage-30d-hover.png"), animations: "disabled" });
    await page.mouse.move(0, 0);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await usageIcon(page).click();
    await expect(range(page, "30d")).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await waitReady(page);
    await usageIcon(page).click();
    await expect(range(page, "30d")).toHaveAttribute("aria-pressed", "true");
    await range(page, "7d").click();

    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(usageIcon(page)).toBeFocused();
    await expect(usageIcon(page)).toHaveAttribute("aria-pressed", "false");
    // the dim layer closes it too, and a second click on the icon (under the dim) closes it
    await usageIcon(page).click();
    await page.locator(".dlg-dim").click({ position: { x: 8, y: 8 } });
    await expect(dialog(page)).toHaveCount(0);
    await usageIcon(page).click();
    await expect(dialog(page)).toBeVisible();
    const icon = (await usageIcon(page).boundingBox())!;
    await page.mouse.click(icon.x + icon.width / 2, icon.y + icon.height / 2);
    await expect(dialog(page)).toHaveCount(0);
  });
});

test.describe("closing a screen gives the chat back as it was", () => {
  test.use({ seed: 40 });

  // Guards the owner's rule that nothing moves: closing Settings or Usage gives the chat back as it was (unsure: no line of his on scroll and caret).
  test("scroll, draft and caret survive Settings and Usage, no frame shows a placeholder, and keys never reach the hidden draft", async ({ page, open, seededThread }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    // an entry of the app's own before this one, so Back has somewhere to go that is not a screen
    await page.evaluate(() => history.pushState(null, "", location.href));
    const tl = page.locator(".tl");
    // the thread is drawn and has settled at the bottom before the scroll moves
    await expect(page.locator(".turn").first()).toBeVisible();
    await expect.poll(() => atBottom(tl)).toBeLessThanOrEqual(4);
    await tl.evaluate((el) => { el.scrollTop = 600; });
    await expect.poll(() => tl.evaluate((el) => el.scrollTop)).toBe(600);
    const top = 600;
    const ta = page.locator("#ta");
    await ta.fill("hello world");
    await ta.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 5));

    // Settings from its shortcut while the draft has focus; then keys and the dictation shortcut
    await ta.focus();
    await page.keyboard.press("Control+Comma");
    await expect(page.locator(".set")).toBeVisible();
    await expect(settingsIcon(page)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#app")).toHaveAttribute("inert", "");
    await page.keyboard.type("zz");
    await page.keyboard.press("Control+Shift+Space");
    const frames = await burst(page, "overlay-settings-close", ".work", () => clickSpot(page, settingsIcon(page)));
    expect(frames.filter((f) => /Loading conversation/.test(f.text)), "no frame shows the loading placeholder").toEqual([]);
    expect(transitionMetrics(frames).transientText, "no frame between Settings and the chat").toEqual([]);
    await expect(page.locator(".set")).toHaveCount(0);
    expect(await tl.evaluate((el) => el.scrollTop)).toBe(top);
    await expect(ta).toHaveValue("hello world");
    // the caret is back in the draft where it was, with nothing put there by the test
    await expect(ta).toBeFocused();
    expect(await ta.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([5, 5]);

    // Usage over the same chat
    await usageIcon(page).click();
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    expect(await tl.evaluate((el) => el.scrollTop)).toBe(top);

    // Back closes a screen and keeps the thread's address; Back after an icon close never reopens it
    const url = page.url();
    await settingsIcon(page).click();
    await expect(page.locator(".set")).toBeVisible();
    await page.goBack();
    await expect(page.locator(".set")).toHaveCount(0);
    expect(page.url()).toBe(url);
    expect(await tl.evaluate((el) => el.scrollTop)).toBe(top);
    await page.goForward();
    await expect(page.locator(".set")).toHaveCount(0);
    await settingsIcon(page).click();
    await expect(page.locator(".set")).toBeVisible();
    await clickSpot(page, settingsIcon(page));
    await expect(page.locator(".set")).toHaveCount(0);
    await page.goBack();
    await expect(page.locator(".set")).toHaveCount(0);
    await expect(dialog(page)).toHaveCount(0);
    expect(page.url()).toBe(url);
    // Settings is a pop-up: a click on Usage's spot switches straight to Usage (settings row 25)
    await settingsIcon(page).click();
    await expect(page.locator(".set")).toBeVisible();
    await clickSpot(page, usageIcon(page));
    await expect(page.locator(".set")).toHaveCount(0);
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    // Models opens its pop-up, and its icon's spot closes it again
    await modelsIcon(page).click();
    await expect(page.getByRole("dialog", { name: "Models" })).toBeVisible();
    await expect(modelsIcon(page)).toHaveAttribute("aria-pressed", "true");
    await clickSpot(page, modelsIcon(page));
    await expect(page.locator(".dlg")).toHaveCount(0);
    expect(await tl.evaluate((el) => el.scrollTop)).toBe(top);
  });
});
