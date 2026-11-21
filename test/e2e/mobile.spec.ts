/// <reference lib="dom" />
// Journeys on a phone: 412x915, touch, the mobile viewport. The layout at 640
// px and below is a top bar (menu, title, new thread), the thread drawer, a
// full-width composer pinned to the bottom and bottom sheets for menus, the
// model picker; Settings is a list screen and a section
// screen with a back button. None of it may scroll the page sideways.
import type { Page } from "@playwright/test";
import { expect, listButton, stack, test, waitReady } from "./fixtures.ts";

/** Thu 2026-11-12 14:00 in Chicago, as in the screenshot rig. */
const NOW = Date.UTC(2026, 10, 12, 20, 0);

test.use({
  viewport: { width: 412, height: 915 },
  isMobile: true,
  hasTouch: true,
  seed: "design",
  seedAt: NOW,
  olderOpen: true,
  timezoneId: "America/Chicago",
  locale: "en-US",
});

/** The page itself never scrolls sideways. */
async function noSideScroll(page: Page, state: string): Promise<void> {
  const [sw, iw] = await page.evaluate(() => [document.scrollingElement?.scrollWidth ?? 0, window.innerWidth]);
  expect(sw, `page width in state "${state}"`).toBeLessThanOrEqual(iw);
}

/** The drawer is open when its first thread row sits inside the viewport. */
const drawerRow = (page: Page) => page.locator(".sb .sb-row").first();

async function openDrawer(page: Page): Promise<void> {
  await page.getByTestId("chat.header.open-threads").tap();
  await expect(drawerRow(page)).toBeInViewport({ ratio: 1 });
}

/** A sheet is full width and sits on the bottom edge. */
async function expectSheet(page: Page, sel: string): Promise<void> {
  const el = page.locator(sel);
  await expect(el).toBeVisible();
  // measure where it rests, not mid-way through its opening animation
  await el.evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished)));
  const box = await el.boundingBox();
  const vp = page.viewportSize();
  expect(box).not.toBeNull();
  expect(vp).not.toBeNull();
  if (box === null || vp === null) return;
  if (sel === "#picker") {
    expect(Math.round(box.width), "fixed phone picker width").toBe(360);
    expect(box.x, "picker has a safe side inset").toBeGreaterThanOrEqual(8);
    expect(Math.round(box.y + box.height), "picker has a safe bottom inset").toBe(vp.height - 8);
    return;
  }
  expect(Math.round(box.x), `${sel} left edge`).toBe(0);
  expect(Math.round(box.width), `${sel} width`).toBe(vp.width);
  expect(Math.round(box.y + box.height), `${sel} bottom edge`).toBe(vp.height);
  expect(box.height, `${sel} height`).toBeLessThanOrEqual(vp.height * 0.7 + 1);
}

// Guards the owner's ruling that the phone is for chat, with the app's own controls: nothing scrolls the page sideways.
test("the thread, drawer, new thread, sheets and settings never scroll the page sideways", async ({ page, open, seededThread }) => {
  await open(`#thread=${seededThread ?? ""}`);
  await waitReady(page);
  await noSideScroll(page, "thread");
  await openDrawer(page);
  await noSideScroll(page, "drawer");
  await page.keyboard.press("Escape");
  await page.getByTestId("chat.header.new-thread").tap();
  await expect(page.locator(".start-mark")).toBeVisible();
  await noSideScroll(page, "new thread");
  await page.locator("#modelBtn").tap();
  await expectSheet(page, "#picker");
  await noSideScroll(page, "picker");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Chat options" }).tap();
  await expectSheet(page, "#optsMenu");
  await noSideScroll(page, "chat options");
  await page.locator("#optsMenu").getByTestId("ui.sheet.close").tap();
  await expect(page.locator("#optsMenu")).toBeHidden();
  await openDrawer(page);
  await page.getByTestId("sidebar.foot.settings").tap();
  await expect(page.locator(".set-list")).toBeVisible();
  await noSideScroll(page, "settings list");
  for (const section of ["General", "Models", "Instructions", "Library", "Tools", "Image generation", "Runtime", "Advanced", "Shortcuts"]) {
    await listButton(page, section).tap();
    await expect(page.locator(".set-bar h2")).toHaveText(section);
    await noSideScroll(page, `settings ${section}`);
    await page.getByTestId("settings.shell.back").tap();
    await expect(page.locator(".set-list")).toBeVisible();
  }
});

// Guards the owner's ruling that the phone is for chat: the drawer picks a thread.
test("the drawer opens and closes, and picking a thread closes it", async ({ page, open, seededThread }) => {
  await open(`#thread=${seededThread ?? ""}`);
  await waitReady(page);
  const title = page.locator(".hdr h2");
  await expect(title).toContainText("Library: Effect Schema books");

  // the scrim closes it, and focus goes back to the menu button
  await openDrawer(page);
  await expect.poll(() => page.evaluate(() => document.querySelector(".sb")?.contains(document.activeElement) ?? false), { message: "focus moves into the drawer" }).toBe(true);
  await page.locator(".scrim").tap({ position: { x: 380, y: 400 } });
  await expect(drawerRow(page)).not.toBeInViewport();
  await expect(page.getByTestId("chat.header.open-threads")).toBeFocused();

  // Escape closes it
  await openDrawer(page);
  await page.keyboard.press("Escape");
  await expect(drawerRow(page)).not.toBeInViewport();

  // the back gesture closes it and stays on the thread
  await openDrawer(page);
  await page.goBack();
  await expect(drawerRow(page)).not.toBeInViewport();
  expect(page.url()).toContain(`#thread=${seededThread ?? ""}`);
  await expect(title).toContainText("Library: Effect Schema books");

  // picking a thread opens it and closes the drawer
  await openDrawer(page);
  await page.locator(".sb .sb-row").filter({ hasText: "Fix the backup cron" }).tap();
  await expect(drawerRow(page)).not.toBeInViewport();
  await expect(title).toContainText("Fix the backup cron");
  await expect(page.locator(".turn.u .bubble").first()).toHaveText("Fix the backup cron");
});

// Guards the owner's ruling that the phone is for chat: a message sends and Stop appears without moving Send.
test("a message sends from the phone composer and its reply streams", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const send = page.getByTestId("chat.composer.send");
  const box = await send.boundingBox();

  await stack.scenario("models", { tokenDelayMs: 60 });
  await page.locator("#ta").fill("Hello from the phone");
  await send.tap();
  const reply = page.locator(".turn.a").last();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(page.locator(".composer button.send")).toHaveCount(1);
  const stop = await page.getByRole("button", { name: "Stop" }).boundingBox();
  // Send keeps its slot (the queue arrow, off while empty) and Stop sits beside it, so typing moves nothing
  expect(await send.boundingBox(), "Send keeps its slot").toEqual(box);
  expect((stop?.x ?? 0) + (stop?.width ?? 0), "Stop sits left of Send").toBeLessThanOrEqual(box?.x ?? 0);
  await expect(reply.locator(".md")).toContainText("You asked: Hello from the phone", { timeout: 10_000 });
  await expect(page.locator(".working")).toHaveCount(0, { timeout: 15_000 });
  await noSideScroll(page, "after a reply");
  // the composer sits on the bottom edge
  const form = await page.locator(".composer").boundingBox();
  expect((form?.y ?? 0) + (form?.height ?? 0)).toBeGreaterThan(915 - 40);
});

const secs = (p: Page) => p.locator(".turn.a").last().locator(".stop-mark .s");

// Guards one record per reply: Stop on the phone is what the computer shows, to the second.
test("Stop on the phone with a message queued: the computer shows the reply stopped at the same seconds and the message on hold", async ({ page, open, browser }) => {
  test.setTimeout(60_000);
  await open();
  await waitReady(page);
  await stack.scenario("slow-drip", { holdAfterTokens: 46 });
  const send = page.getByTestId("chat.composer.send");
  await page.locator("#ta").fill("How do I check disk space before a download?");
  await send.tap();
  await expect(page.locator(".turn.a .md ul li")).toHaveCount(3, { timeout: 15_000 });
  await page.locator("#ta").fill("Queued on the phone");
  await send.tap();
  await expect(page.locator(".qt-r")).toHaveCount(1);

  const computer = await browser.newContext({ viewport: { width: 1280, height: 800 }, timezoneId: "America/Chicago", locale: "en-US" });
  const desk = await computer.newPage();
  await desk.goto(page.url());
  await waitReady(desk);
  await expect(desk.locator(".qt-r")).toHaveText("Queued on the phone");
  await expect(desk.locator(".turn.a").last().locator(".md")).not.toBeEmpty();

  await page.getByRole("button", { name: "Stop", exact: true }).tap();
  await expect(secs(page)).toHaveText(/^\d+ s$/, { timeout: 10_000 });
  await expect(desk.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, { timeout: 10_000 });
  await expect.poll(async () => (await secs(desk).textContent())?.trim()).toBe((await secs(page).textContent())?.trim());
  await expect(desk.locator(".qt-r")).toContainText("On hold");
  await expect(page.locator(".qt-r")).toContainText("On hold");
  await desk.screenshot({ path: test.info().outputPath("computer-after-phone-stop.png") });
  await page.screenshot({ path: test.info().outputPath("phone-after-stop.png") });
  await computer.close();
});

// Guards the owner's ruling that the phone is for chat: a model is picked from the phone.
test("the picker opens as a bottom sheet and picks a model", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await page.locator("#modelBtn").tap();
  await expectSheet(page, "#picker");
  // the search field does not grab focus, so the keyboard stays down
  await expect(page.locator("#pkSearch")).not.toBeFocused();
  const row = page.locator('#picker .pk-r[data-m="gemma4:12b"]');
  await expect(page.getByTestId("models.picker.close")).toBeVisible();
  await row.tap();
  await expect(page.locator("#picker .pk-context")).toBeVisible();
  await page.locator("#picker").getByRole("radio", { name: /^16k/ }).tap();
  await expect(page.locator("#picker")).toBeHidden();
  await expect(page.locator("#modelBtn")).toContainText("Gemma 4 12B");

  // the sheet's close button closes it
  await page.locator("#modelBtn").tap();
  await page.getByTestId("models.picker.close").tap();
  await expect(page.locator("#picker")).toBeHidden();
});

// Guards the owner's ruling that the phone is for chat: Settings goes back to it (unsure: he may want phone Settings untested).
test("settings opens a section and goes back to the list and the chat", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await openDrawer(page);
  await page.getByTestId("sidebar.foot.settings").tap();
  const list = page.locator(".set-list");
  await expect(list).toBeVisible();
  await expect(drawerRow(page)).not.toBeInViewport();
  await page.getByTestId("settings.sections.open-models").tap();
  await expect(page.locator(".set-bar h2")).toHaveText("Models");
  await expect(list).toBeHidden();
  await page.getByTestId("settings.shell.back").tap();
  await expect(list).toBeVisible();
  await page.getByTestId("settings.shell.done").tap();
  await expect(page.locator(".start-mark")).toBeVisible();
});

// Settings on a phone, and the model rows' Remove at phone widths.
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true };
const NARROW = { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true };

const phoneSettings = async (page: Page, section?: string) => {
  await openDrawer(page);
  await page.getByTestId("sidebar.foot.settings").tap();
  await expect(page.locator(".set-list")).toBeVisible();
  if (section !== undefined) await listButton(page, section).tap();
};

test.describe("Settings on a phone", () => {
  test.use(PHONE);

  // Guards the owner's rule to say a thing once, on the Runtime page (unsure: he may never have looked at it on a phone).
  test("Runtime says the port once and its status card has no dead space", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await phoneSettings(page, "Runtime");
    const text = (await page.locator(".set-in").innerText()).toLowerCase();
    expect(text.split("port ").length - 1, "port mentions in prose").toBe(0);
    const row = page.locator(".srow", { has: page.locator(".stat") });
    // the status row carries the switch now, so its value column is never an empty one
    await expect(row.locator(".sv").getByRole("button")).toHaveText(/^Use .*Ollama$/);
  });
});

// Guards the owner's scorecard (Q17) at 360 px: the model button cut to "Qwen …" and hid the size,
// a table's cut fell between columns so its last column looked lost, and the rail clipped its marker.
test.describe("a thread at 360", () => {
  test.use({ ...NARROW, seed: "design-code" });
  test("the model button keeps the size, a wide table stacks each row as a card with nothing cut, the rail marker is whole", async ({ page, open, seededThread }, info) => {
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    const name = page.locator("#modelBtn .picker-trigger-name");
    await expect(name).toHaveAttribute("data-fit", "short");
    await expect(name.locator(".ptn-s")).toBeVisible();
    await expect(name.locator(".ptn-s")).toHaveText("Qwen 9B");
    await expect(name.locator(".ptn-f"), "the full name stays for screen readers").toHaveText("Qwen 3.5 9B");
    await expect(page.locator("#modelBtn"), "a screen reader hears the full name, not both").toHaveAccessibleName(/^Qwen 3\.5 9B(?!.*Qwen 9B)/);
    const room = await name.evaluate((el) => ({ text: el.querySelector<HTMLElement>(".ptn-s")?.offsetWidth ?? 0, box: el.clientWidth, parts: [...el.parentElement!.children].map((c) => `${c.className}:${Math.round(c.getBoundingClientRect().width)}`).join(" ") }));
    expect(room.text, `the short name shows whole (${room.parts})`).toBeLessThanOrEqual(room.box);
    const table = page.locator(".turn.a .md table").last();
    await table.scrollIntoViewIfNeeded();
    // council climb-025 Q17: under about 420 px no column is cut at the box's edge; each row is a card
    const cut = await table.evaluate((el) => {
      const right = el.getBoundingClientRect().right;
      return { scrolls: el.scrollWidth - el.clientWidth, past: [...el.querySelectorAll("td")].filter((td) => td.getBoundingClientRect().right > right + 1).map((td) => td.textContent ?? "") };
    });
    expect(cut.scrolls, "the table fits its box").toBeLessThanOrEqual(1);
    expect(cut.past, "cells past the box's edge").toEqual([]);
    const pages = table.locator('td[data-label="Pages"]').first();
    await pages.scrollIntoViewIfNeeded();
    await expect(pages, "the last column's line names it").toBeInViewport({ ratio: 1 });
    expect(await pages.evaluate((td) => getComputedStyle(td, "::before").content), "the line's name").toBe('"Pages"');
    await table.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("after-360-thread.png") });
    // the same cards at a common phone's 412
    await page.setViewportSize({ width: 412, height: 780 });
    await table.scrollIntoViewIfNeeded();
    expect(await table.evaluate((el) => el.scrollWidth - el.clientWidth), "the table fits its box at 412").toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath("after-412-thread.png") });
    await page.setViewportSize({ width: 360, height: 780 });
    await page.locator("#modelBtn").tap();
    await expect(page.locator("#picker")).toBeVisible();
    await page.locator("#picker").evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished)));
    const mark = await page.locator('#picker .pk-fam[aria-pressed="true"]').evaluate((el) => {
      const rail = el.closest(".pk-rail")!.getBoundingClientRect(), b = el.getBoundingClientRect();
      return { right: b.right - Number.parseFloat(getComputedStyle(el, "::after").right), railRight: rail.right };
    });
    expect(mark.right, "the marker ends inside the rail").toBeLessThan(mark.railRight - 1);
    // council climb-025 Q17: the tapped button's highlight showed as a teal block over "Download models"
    expect(await page.locator("#modelBtn").evaluate((b) => getComputedStyle(b).getPropertyValue("-webkit-tap-highlight-color")), "the browser's tap highlight").toBe("rgba(0, 0, 0, 0)");
    await page.screenshot({ path: info.outputPath("after-360-picker.png") });
  });
});

// Guards council climb-025 Q17: a long command was cut at the edge with no way to read it whole in place.
test.describe("a code block on a phone", () => {
  test.use({ ...PHONE, seed: "design-code" });
  // council climb-025 Q17 (2026-11-17): under 420 px a block starts wrapped; Wrap still unwraps it
  test("a block starts wrapped, Wrap sits beside Copy and unwraps it to a faded side, and Copy stays on screen over a tall block", async ({ page, open, seededThread }, info) => {
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    const block = page.locator(".turn.a .md .cb").last();
    const pre = block.locator("pre");
    await block.scrollIntoViewIfNeeded();
    const wrap = block.getByTestId("chat.markdown.wrap-code");
    const copy = block.getByTestId("chat.markdown.copy-code");
    const sideways = () => pre.evaluate((el) => ({ wide: el.scrollWidth - el.clientWidth, more: el.dataset.more ?? "" }));
    await expect(wrap).toHaveAttribute("aria-pressed", "true");
    const start = await sideways();
    expect(start.wide, "a block starts wrapped: no sideways scroll").toBeLessThanOrEqual(1);
    expect(start.more, "and no hidden side").toBe("");
    const [w, c] = [await wrap.boundingBox(), await copy.boundingBox()];
    expect(Math.min(w?.width ?? 0, w?.height ?? 0), "Wrap size").toBeGreaterThanOrEqual(44);
    expect(Math.abs((w?.y ?? 0) - (c?.y ?? 99)), "Wrap is on Copy's row").toBeLessThanOrEqual(1);
    expect((w?.x ?? 0) + (w?.width ?? 0), "Wrap sits left of Copy").toBeLessThanOrEqual((c?.x ?? 0) + 1);
    await page.screenshot({ path: info.outputPath("after-412-code.png") });
    await wrap.tap();
    await expect(wrap).toHaveAttribute("aria-pressed", "false");
    await expect(pre).toHaveAttribute("data-more", /\bend\b/);
    expect(await pre.evaluate((el) => getComputedStyle(el).maskImage), "the right edge fades").toContain("gradient");
    await page.screenshot({ path: info.outputPath("after-412-code-unwrapped.png") });
    await wrap.tap();
    await expect(wrap).toHaveAttribute("aria-pressed", "true");
    expect((await sideways()).wide, "wrapped again, no sideways scroll").toBeLessThanOrEqual(1);
    const tl = page.locator(".tl");
    await block.evaluate((el) => {
      const s = el.closest<HTMLElement>(".tl")!;
      s.scrollTop += el.getBoundingClientRect().top - s.getBoundingClientRect().top + 80;
    });
    const [top, box] = [(await tl.boundingBox())?.y ?? 0, await copy.boundingBox()];
    expect(box?.y ?? -1, "Copy rides the top of the thread while the block is under it").toBeGreaterThanOrEqual(top + 16);
    await page.screenshot({ path: info.outputPath("after-412-code-wrapped.png") });
  });
});

test.describe("a code block on a tablet", () => {
  test.use({ viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true, seed: "design-code" });
  test("has no Wrap toggle above 480 px", async ({ page, open, seededThread }) => {
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    const block = page.locator(".turn.a .md .cb").last();
    await expect(block.getByTestId("chat.markdown.copy-code")).toBeVisible();
    await expect(block.getByTestId("chat.markdown.wrap-code")).toBeHidden();
  });
});

for (const [width, use] of [["412", PHONE], ["360", NARROW]] as const) {
  test.describe(`Settings at ${width}`, () => {
    test.use(use);

    // Guards the owner's ruling: Remove lives in a model row's ⋯ menu.
    test("Remove stays in a row's ⋯ menu, 44 px to reach and on the screen", async ({ page, open }, info) => {
      await open();
      await waitReady(page);
      await phoneSettings(page, "Models");
      const row = page.locator('.mp-row[data-dm="gemma4:12b"]');
      await expect(row).toBeVisible();
      await expect(page.locator(".mp")).not.toContainText("Remove");
      const more = row.getByTestId("models.row-menu.open");
      const b = await more.boundingBox();
      expect(Math.min(b?.width ?? 0, b?.height ?? 0), "⋯ size").toBeGreaterThanOrEqual(44);
      await more.tap();
      // council climb-025 Q17: the row's ⋯ menu opens as a bottom sheet, as the thread menu does
      await expectSheet(page, ".mp-menu");
      await expect(page.locator(".mp-menu").getByTestId("ui.sheet.close")).toBeVisible();
      await page.screenshot({ path: info.outputPath(`after-${width}-model-sheet.png`) });
      await page.locator(".mp-menu").getByTestId("ui.sheet.close").tap();
      await expect(page.locator(".mp-menu")).toHaveCount(0);
      await more.tap();
      const remove = row.getByRole("menuitem", { name: /^Remove…/ });
      await expect(remove).toBeInViewport({ ratio: 1 });
      await remove.tap();
      await page.getByRole("dialog").locator(".mp-danger").tap();
      await expect(row).toHaveCount(0);
    });
  });
}
