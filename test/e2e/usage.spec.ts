// The Usage pop-up (Usage.tsx, Panel.tsx) and the screens over the chat: the
// footer icons are toggles, Usage lies over the chat on a dim layer, Settings
// covers the chat area while the chat stays mounted under it, and closing
// either gives the chat back as it was. The screenshots go to the test's
// output folder (usage-*.png, overlay-after.png).
import type { Locator, Page } from "@playwright/test";
import { appUrl } from "./env.ts";
import { burst, transitionMetrics } from "./flicker-probe.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";
import { QWEN14, desktopBridge, footerSocket } from "./footer-fixture.ts";

const usageIcon = (page: Page) => page.locator(".sb-foot .usage");
const settingsIcon = (page: Page) => page.locator(".sb-foot").getByRole("button", { name: /^Settings/ });
const modelsIcon = (page: Page) => page.locator(".sb-foot").getByRole("button", { name: /^Models/ });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Usage" });
const range = (page: Page, name: string) => page.getByRole("group", { name: "Range" }).getByRole("button", { name, exact: true });
const metric = (page: Page, name: string) => page.getByRole("group", { name: "Chart" }).getByRole("button", { name, exact: true });
const shot = (name: string) => test.info().outputPath(name);

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

/** The chat's scroll position, and the first message row in view: the "mark" on the overlay strips. */
async function scrollMark(page: Page): Promise<string> {
  return page.locator(".tl").evaluate((tl) => {
    const top = tl.getBoundingClientRect().top;
    const row = [...tl.querySelectorAll<HTMLElement>(".turn")].find((t) => t.getBoundingClientRect().bottom > top + 4);
    const words = (row?.innerText ?? "").replace(/\s+/g, " ").slice(0, 48);
    return `scrollTop ${Math.round(tl.scrollTop)} px · first in view: ${words}`;
  });
}

const atBottom = (tl: Locator) => tl.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

/** Lay out frames in rows of three with their captions and save one PNG. */
const img = (f: { png: Buffer; scale?: number }) => `<img src="data:image/png;base64,${f.png.toString("base64")}"${f.scale === undefined ? "" : ` style="width:auto;zoom:${f.scale};image-rendering:pixelated"`}>`;

async function strip(page: Page, rows: { title: string; frames: { caption: string; png: Buffer; scale?: number }[] }[], file: string): Promise<void> {
  const html = rows.map((r) => `<h2>${r.title}</h2><div class="row">${r.frames.map((f) => `<figure>${img(f)}<figcaption>${f.caption}</figcaption></figure>`).join("")}</div>`).join("");
  const sheet = await page.context().newPage();
  await sheet.setViewportSize({ width: 1500, height: 400 });
  await sheet.setContent(`<style>body{margin:16px;background:#111;color:#eee;font:13px system-ui}h2{font-size:15px;margin:12px 0 6px}.row{display:flex;gap:12px}figure{margin:0;width:480px}img{width:480px;border:1px solid #444}figcaption{margin-top:4px;color:#f5b041}</style>${html}`);
  await sheet.screenshot({ path: file, fullPage: true });
  await sheet.close();
}

test.describe("a week of three models", () => {
  test.use({ seed: "usage", timezoneId: "UTC" });

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
    // the icon closes it here; the close button is the phone's
    await expect(dialog(page).getByRole("button", { name: "Close" })).toBeHidden();
    // over the chat: the dim layer and the chat still there under it, inert
    await expect(page.locator(".panel-dim")).toBeVisible();
    await expect(page.locator(".turn").first()).toBeVisible();
    expect(await page.locator(".main > div").first().evaluate((d) => (d as HTMLElement).inert)).toBe(true);

    await expect(range(page, "7 d")).toHaveAttribute("aria-pressed", "true");
    const rows = page.locator(".us-rows tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(page.locator(".us-chart svg g")).toHaveCount(3);
    await page.screenshot({ path: shot("usage-screen.png") });

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
    await page.keyboard.press("ArrowLeft");
    await page.screenshot({ path: shot("usage-screen-day.png") });
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
    await expect(rows.first().locator("td:nth-child(4)")).toHaveAttribute("data-tipt", /^Reads prompts at [\d,]+ tok\/s$/);
    await page.screenshot({ path: shot("usage-screen-speed.png") });
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

  test("a turn ending in another window changes the figures in place", async ({ page, open, seededThread }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    await usageIcon(page).click();
    await expect(dialog(page)).toBeVisible();
    const total = page.locator(".us-num").first();
    const before = await total.getAttribute("data-tipt");
    const boxes = async () => Promise.all([".panel", ".us-nums", ".us-chart", ".us-rows thead"].map((s) => page.locator(s).boundingBox()));
    const at = await boxes();
    const other = await page.context().newPage();
    await other.goto(appUrl(`#thread=${seededThread ?? ""}`));
    await waitReady(other);
    await sendMessage(other, "One more question");
    await expect(other.locator(".turn.a").last()).toHaveClass(/done/, { timeout: 15_000 });
    await expect(total).not.toHaveAttribute("data-tipt", before ?? "");
    expect(await boxes(), "nothing moved").toEqual(at);
    await other.close();
  });

  test("a phone-width window: Usage from the drawer, no sideways scroll, its own close button, Back closes", async ({ page, open, seededThread }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    await page.getByRole("button", { name: "Open threads" }).click();
    // 44 px touch targets, measured once the drawer has slid all the way in (.drawer .sb's transform transition)
    await expect.poll(() => page.locator(".sb").evaluate((el) => el.getBoundingClientRect().left === 0 && el.getAnimations().length === 0)).toBe(true);
    for (const b of await page.locator(".sb-foot button.ibtn").all()) expect((await b.boundingBox())?.width).toBe(44);
    await usageIcon(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect(page.locator(".sb-foot")).not.toBeInViewport();
    expect(await page.locator(".panel").evaluate((p) => p.scrollWidth <= p.clientWidth)).toBe(true);
    const close = dialog(page).getByRole("button", { name: "Close" });
    expect((await close.boundingBox())?.width).toBe(44);
    await close.click();
    await expect(dialog(page)).toHaveCount(0);
    const url = page.url();
    await page.getByRole("button", { name: "Open threads" }).click();
    await usageIcon(page).click();
    await expect(dialog(page)).toBeVisible();
    await page.goBack();
    await expect(dialog(page)).toHaveCount(0);
    expect(page.url()).toBe(url);
  });

  test("the bot in the download ring, at real size and 4x", async ({ page, open }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await desktopBridge(page);
    const s = await footerSocket(page);
    await open();
    await waitReady(page);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    s.pull(QWEN14);
    await expect(modelsIcon(page).locator(".ring")).toHaveCount(1);
    await page.mouse.move(900, 400);
    const foot = await page.locator(".sb-foot").screenshot();
    const one = await modelsIcon(page).screenshot();
    await strip(page, [{ title: "Models downloading: the bot in the ring", frames: [{ caption: "real size (footer)", png: foot }, { caption: "the same pixels at 4x", png: one, scale: 4 }] }], shot("usage-ring.png"));
    // the footer with the changed icons outlined
    await page.addStyleTag({ content: ".sb-foot button[aria-label^='Models'],.sb-foot .usage{outline:2px solid #f5b041;outline-offset:1px}" });
    await page.locator(".sb-foot").screenshot({ path: shot("usage-footer-after.png") });
  });
});

test("no usage yet: the same frame, a flat zero line and 0 in the numbers", async ({ page, open }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open();
  await waitReady(page);
  await usageIcon(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(page.locator(".us-num b")).toHaveText(["0", "0", "0", "0", "0 min"]);
  await expect(page.locator(".us-rows tbody tr")).toHaveCount(0);
  // no column headers over no rows
  await expect(page.locator(".us-rows thead")).toHaveCount(0);
  await expect(page.locator(".us-chart .us-base")).toHaveCount(1);
  await expect(page.locator(".us-chart svg g")).toHaveCount(0);
  await page.screenshot({ path: shot("usage-screen-empty.png") });
});

test.describe("closing a screen gives the chat back as it was", () => {
  test.use({ seed: 40 });

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
    const view = () => page.locator(".main").screenshot();

    const settingsRow = [{ caption: `chat · ${await scrollMark(page)}`, png: await view() }];
    // Settings from its shortcut while the draft has focus; then keys and the dictation shortcut
    await ta.focus();
    await page.keyboard.press("Control+Comma");
    await expect(page.locator(".set")).toBeVisible();
    await expect(settingsIcon(page)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".stage")).toHaveCSS("visibility", "hidden");
    await page.keyboard.type("zz");
    await page.keyboard.press("Control+Shift+Space");
    settingsRow.push({ caption: "Settings open (chat kept, hidden)", png: await view() });
    const frames = await burst(page, "overlay-settings-close", ".work", () => settingsIcon(page).click());
    expect(frames.filter((f) => /Loading conversation/.test(f.text)), "no frame shows the loading placeholder").toEqual([]);
    expect(transitionMetrics(frames).transientText, "no frame between Settings and the chat").toEqual([]);
    await expect(page.locator(".set")).toHaveCount(0);
    expect(await tl.evaluate((el) => el.scrollTop)).toBe(top);
    settingsRow.push({ caption: `closed · ${await scrollMark(page)}`, png: await view() });
    await expect(ta).toHaveValue("hello world");
    // the caret is back in the draft where it was, with nothing put there by the test
    await expect(ta).toBeFocused();
    expect(await ta.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([5, 5]);

    // Usage over the same chat
    const usageRow = [{ caption: `chat · ${await scrollMark(page)}`, png: await view() }];
    await usageIcon(page).click();
    await expect(dialog(page)).toBeVisible();
    usageRow.push({ caption: "Usage open over the chat", png: await view() });
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    expect(await tl.evaluate((el) => el.scrollTop)).toBe(top);
    usageRow.push({ caption: `closed · ${await scrollMark(page)}`, png: await view() });
    await strip(page, [{ title: "Settings: open from the icon, close from the icon", frames: settingsRow }, { title: "Usage: open from the icon, Esc", frames: usageRow }], shot("overlay-after.png"));

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
    // Models opens Settings › Models, and closes it again
    await modelsIcon(page).click();
    await expect(page.locator(".set")).toBeVisible();
    await expect(modelsIcon(page)).toHaveAttribute("aria-pressed", "true");
    await modelsIcon(page).click();
    await expect(page.locator(".set")).toHaveCount(0);
    expect(await tl.evaluate((el) => el.scrollTop)).toBe(top);
  });

  test("a reply streaming under Settings is still following the bottom when Settings closes", async ({ page, open, seededThread }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await stack.scenario("slow-drip", { tokenDelayMs: 30, firstTokenDelayMs: 0, longDrip: 1 });
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    await sendMessage(page, "Check disk space");
    const reply = page.locator(".turn.a").last();
    await expect(reply.locator(".md p").first()).toBeVisible();
    const tl = page.locator(".tl");
    await expect.poll(() => atBottom(tl)).toBeLessThanOrEqual(4);
    await settingsIcon(page).click();
    await expect(page.locator(".set")).toBeVisible();
    const length = await reply.evaluate((el) => el.textContent?.length ?? 0);
    await expect.poll(() => reply.evaluate((el) => el.textContent?.length ?? 0), { message: "the reply keeps arriving under Settings" }).toBeGreaterThan(length + 40);
    await settingsIcon(page).click();
    await expect(page.locator(".set")).toHaveCount(0);
    expect(await atBottom(tl), "still at the bottom the moment Settings closes").toBeLessThanOrEqual(4);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
  });
});
