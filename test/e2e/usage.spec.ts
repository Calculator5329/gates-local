// The Usage pop-up (Usage.tsx, Panel.tsx) and the screens over the chat: the
// footer icons are toggles, Usage lies over the chat on a dim layer, Settings
// covers the chat area while the chat stays mounted under it, and closing
// either gives the chat back as it was.
import type { Locator, Page } from "@playwright/test";
import { burst, transitionMetrics } from "./flicker-probe.ts";
import { expect, test, waitReady } from "./fixtures.ts";

const usageIcon = (page: Page) => page.locator(".sb-foot .usage");
const settingsIcon = (page: Page) => page.locator(".sb-foot").getByRole("button", { name: /^Settings/ });
const modelsIcon = (page: Page) => page.locator(".sb-foot").getByRole("button", { name: /^Models/ });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Usage" });
const range = (page: Page, name: string) => page.getByRole("group", { name: "Range" }).getByRole("button", { name, exact: true });
const metric = (page: Page, name: string) => page.getByRole("group", { name: "Chart" }).getByRole("button", { name, exact: true });

interface FrameWindow extends Window { usageFrames?: string[] }

/** Record, every animation frame, whether the pop-up is absent, complete, or showing placeholders. */
async function watchPanel(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const w = window as FrameWindow;
    w.usageFrames = [];
    const tick = () => {
      const p = document.querySelector(".panel");
      w.usageFrames?.push(p === null ? "none" : p.querySelector(".us-ph") !== null ? "placeholder" : p.querySelector(".us-nums") !== null ? "complete" : "empty");
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return () => page.evaluate(() => (window as FrameWindow).usageFrames ?? []);
}

const atBottom = (tl: Locator) => tl.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

test.describe("a week of three models", () => {
  test.use({ seed: "usage", timezoneId: "UTC" });

  // Guards the owner's rulings on Usage: a pop-up from the footer icon, over the chat, complete on its first frame.
  test("opens complete from the footer over the chat; ranges, hover, arrows and Speed; Esc closes", async ({ page, open, seededThread }) => {
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
    const x = dialog(page).getByRole("button", { name: "Close" });
    await expect(x).toBeVisible();
    const [xb, db] = [(await x.boundingBox())!, (await dialog(page).boundingBox())!];
    expect(db.x + db.width - (xb.x + xb.width), "Close is at the right edge").toBeLessThan(56);
    expect(xb.y - db.y, "Close is on the top row").toBeLessThan(40);
    await expect(page.locator(".us-share")).toHaveCount(0);
    await x.click();
    await expect(dialog(page)).toHaveCount(0);
    await usageIcon(page).click();
    await expect(dialog(page)).toBeVisible();
    // over the chat: the dim layer and the chat still there under it, inert
    await expect(page.locator(".panel-dim")).toBeVisible();
    await expect(page.locator(".turn").first()).toBeVisible();
    expect(await page.locator(".main > div").first().evaluate((d) => (d as HTMLElement).inert)).toBe(true);

    await expect(range(page, "7 d")).toHaveAttribute("aria-pressed", "true");
    const rows = page.locator(".us-rows tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(page.locator(".us-chart svg g")).toHaveCount(3);

    const at = page.locator("#us-at");
    const span = await at.innerText();
    const rangeRows = await rows.allInnerTexts();
    // the pointer on a day: the heading names it and the rows show that day
    const chart = page.locator(".us-chart");
    const box = (await chart.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(at).not.toHaveText(span);
    expect(await rows.allInnerTexts()).not.toEqual(rangeRows);
    await page.mouse.move(box.x + box.width / 2, box.y - 60);
    await expect(at).toHaveText(span);
    expect(await rows.allInnerTexts()).toEqual(rangeRows);

    // arrows from the keyboard: the first press is the last day, then back one at a time
    await chart.focus();
    await page.keyboard.press("ArrowLeft");
    const today = await at.innerText();
    expect(today).not.toBe(span);
    await page.keyboard.press("ArrowLeft");
    await expect(at).not.toHaveText(today);
    await page.keyboard.press("End");
    await expect(at).toHaveText(today);

    // ranges: each one re-reads nothing and changes the heading's span; the choice is remembered
    // All starts at the first day with usage, which here is the week's first day: each range differs from the one before
    let before = span;
    for (const name of ["24 h", "30 d", "All"]) {
      await range(page, name).click();
      await expect(range(page, name)).toHaveAttribute("aria-pressed", "true");
      await expect(at).not.toHaveText(before);
      before = await at.innerText();
    }
    await expect(at).toHaveText(span);
    await range(page, "30 d").click();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await usageIcon(page).click();
    await expect(range(page, "30 d")).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await waitReady(page);
    await usageIcon(page).click();
    await expect(range(page, "30 d")).toHaveAttribute("aria-pressed", "true");
    await range(page, "7 d").click();

    // Speed: tok/s, a line for each model and none for Other, gaps where a model was not used, never a zero
    await metric(page, "Speed").click();
    await expect(page.locator(".us-top")).toContainText("tok/s");
    await expect(page.locator(".us-chart svg g")).toHaveCount(3);
    const paths = await page.locator(".us-chart svg g").evaluateAll((gs) => gs.map((g) => [...g.querySelectorAll("path")].map((p) => p.getAttribute("d") ?? "").join("")));
    expect(paths.some((d) => (d.match(/M/g) ?? []).length >= 2), "a model missing for a day breaks its line").toBe(true);
    for (const d of paths) expect(d, "no point sits on the zero line").not.toMatch(/ 160\.0/);
    const speeds = await rows.locator("td:nth-child(4)").allInnerTexts();
    for (const s of speeds) expect(s).toMatch(/^\d+$/);
    await expect(rows.first().locator("td:nth-child(4)")).toHaveAttribute("data-tip", /^Reads prompts at [\d,]+ tok\/s$/);
    await metric(page, "Tokens").click();

    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(usageIcon(page)).toBeFocused();
    await expect(usageIcon(page)).toHaveAttribute("aria-pressed", "false");
    // the dim layer closes it too, and the icon is a toggle
    await usageIcon(page).click();
    await page.locator(".panel-dim").click({ position: { x: 8, y: 8 } });
    await expect(dialog(page)).toHaveCount(0);
    await usageIcon(page).click();
    await expect(dialog(page)).toBeVisible();
    await usageIcon(page).click();
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
    await expect(page.locator(".stage")).toHaveCSS("visibility", "hidden");
    await page.keyboard.type("zz");
    await page.keyboard.press("Control+Shift+Space");
    const frames = await burst(page, "overlay-settings-close", ".work", () => settingsIcon(page).click());
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
    await settingsIcon(page).click();
    await expect(page.locator(".set")).toHaveCount(0);
    await page.goBack();
    await expect(page.locator(".set")).toHaveCount(0);
    await expect(dialog(page)).toHaveCount(0);
    expect(page.url()).toBe(url);
    // Settings and Usage swap straight to each other
    await settingsIcon(page).click();
    await usageIcon(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect(page.locator(".set")).toHaveCount(0);
    await page.keyboard.press("Escape");
    // Models is its own pop-up; its Close gives the chat back
    const models = page.getByRole("dialog", { name: "Models" });
    await modelsIcon(page).click();
    await expect(models).toBeVisible();
    await expect(modelsIcon(page)).toHaveAttribute("aria-pressed", "true");
    await models.getByRole("button", { name: "Close", exact: true }).click();
    await expect(models).toHaveCount(0);
    expect(await tl.evaluate((el) => el.scrollTop)).toBe(top);
  });
});
