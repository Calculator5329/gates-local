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
  await page.getByRole("button", { name: "Open threads" }).tap();
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
  await page.locator(".hdr").getByRole("button", { name: "New thread" }).tap();
  await expect(page.locator(".start-mark")).toBeVisible();
  await noSideScroll(page, "new thread");
  await page.locator("#modelBtn").tap();
  await expectSheet(page, "#picker");
  await noSideScroll(page, "picker");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Chat options" }).tap();
  await expectSheet(page, "#optsMenu");
  await noSideScroll(page, "chat options");
  await page.locator("#optsMenu").getByRole("button", { name: "Close" }).tap();
  await expect(page.locator("#optsMenu")).toBeHidden();
  await openDrawer(page);
  await page.locator(".sb").getByRole("button", { name: "Settings" }).tap();
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
  await expect(page.getByRole("button", { name: "Open threads" })).toBeFocused();

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

// Guards the owner's ruling that the phone is for chat: a model is picked from the phone.
test("the picker opens as a bottom sheet and picks a model", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await page.locator("#modelBtn").tap();
  await expectSheet(page, "#picker");
  // the search field does not grab focus, so the keyboard stays down
  await expect(page.locator("#pkSearch")).not.toBeFocused();
  const row = page.locator('#picker .pk-r[data-m="gemma4:12b"]');
  await expect(page.locator("#picker").getByRole("button", { name: "Close" })).toBeVisible();
  await row.tap();
  await expect(page.locator("#picker .pk-context")).toBeVisible();
  await page.locator("#picker").getByRole("radio", { name: /^16k/ }).tap();
  await expect(page.locator("#picker")).toBeHidden();
  await expect(page.locator("#modelBtn")).toContainText("Gemma 4 12B");

  // the sheet's close button closes it
  await page.locator("#modelBtn").tap();
  await page.locator("#picker").getByRole("button", { name: "Close" }).tap();
  await expect(page.locator("#picker")).toBeHidden();
});

// Guards the owner's ruling that the phone is for chat: Settings goes back to it (unsure: he may want phone Settings untested).
test("settings opens a section and goes back to the list and the chat", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await openDrawer(page);
  await page.locator(".sb").getByRole("button", { name: "Settings" }).tap();
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

