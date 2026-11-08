/// <reference lib="dom" />
// Journeys on a phone: 412x915, touch, the mobile viewport. The layout at 640
// px and below is a top bar (menu, title, new thread), the thread drawer, a
// full-width composer pinned to the bottom and bottom sheets for menus, the
// model picker and the GPU panel; Settings is a list screen and a section
// screen with a back button. None of it may scroll the page sideways.
import type { Page } from "@playwright/test";
import { expect, stack, test, waitReady } from "./fixtures.ts";

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
  expect(Math.round(box.x), `${sel} left edge`).toBe(0);
  expect(Math.round(box.width), `${sel} width`).toBe(vp.width);
  expect(Math.round(box.y + box.height), `${sel} bottom edge`).toBe(vp.height);
  expect(box.height, `${sel} height`).toBeLessThanOrEqual(vp.height * 0.7 + 1);
}

test("the thread, drawer, new thread, sheets and settings never scroll the page sideways", async ({ page, open, seededThread }) => {
  await open(`#thread=${seededThread ?? ""}`);
  await waitReady(page);
  await noSideScroll(page, "thread");
  await openDrawer(page);
  await noSideScroll(page, "drawer");
  await page.keyboard.press("Escape");
  // the thread menu opens the GPU panel as a sheet
  await page.locator(".hdr-t").tap();
  await page.locator("#moreMenu").getByRole("menuitem", { name: "GPU memory" }).tap();
  await expectSheet(page, "#fitPanel");
  await expect(page.locator("#fitPanel")).toContainText("Where the memory goes");
  await noSideScroll(page, "GPU sheet");
  await page.locator("#fitPanel .fpn-h").getByRole("button", { name: /^Close/ }).tap();
  await expect(page.locator("#fitPanel")).toBeHidden();
  await page.locator(".hdr").getByRole("button", { name: "New thread" }).tap();
  await expect(page.locator(".hero")).toBeVisible();
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
  for (const section of ["General", "Models", "Library", "Tools", "Image generation", "Runtime", "Advanced", "Shortcuts"]) {
    await page.locator(".set-list").getByRole("button", { name: section }).tap();
    await expect(page.locator(".set-bar h2")).toHaveText(section);
    await noSideScroll(page, `settings ${section}`);
    await page.getByRole("button", { name: "Back to Settings" }).tap();
    await expect(page.locator(".set-list")).toBeVisible();
  }
});

test.describe("first run", () => {
  // first run shows only on an empty store
  test.use({ seed: 0, skipFirstRun: false });
  test("fits the phone without sideways scroll", async ({ page, open }) => {
    await open();
    await expect(page.locator(".first").getByRole("heading", { name: "Ready to chat" })).toBeVisible();
    await noSideScroll(page, "first run");
    const cta = await page.getByRole("button", { name: "Start chatting" }).boundingBox();
    expect(cta?.height ?? 0, "Start chatting height").toBeGreaterThanOrEqual(44);
    await page.getByRole("button", { name: "Start chatting" }).tap();
    await expect(page.locator(".hero")).toBeVisible();
  });
});

test("the drawer opens and closes, and picking a thread closes it", async ({ page, open, seededThread }) => {
  await open(`#thread=${seededThread ?? ""}`);
  await waitReady(page);
  const title = page.locator(".hdr h2, .hdr .hdr-t").first();
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

test("a message sends from the phone composer and its reply streams", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const send = page.getByRole("button", { name: "Send message" });
  const box = await send.boundingBox();
  expect(box?.width ?? 0, "send width").toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0, "send height").toBeGreaterThanOrEqual(44);
  const font = await page.locator("#ta").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(font, "message box font size").toBeGreaterThanOrEqual(16);

  await stack.scenario("models", { tokenDelayMs: 60 });
  await page.locator("#ta").fill("Hello from the phone");
  await send.tap();
  const reply = page.locator(".turn.a").last();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  const stop = await page.getByRole("button", { name: "Stop" }).boundingBox();
  expect(Math.min(stop?.width ?? 0, stop?.height ?? 0), "stop size").toBeGreaterThanOrEqual(44);
  await expect(reply.locator(".md")).toContainText("You asked: Hello from the phone", { timeout: 10_000 });
  await expect(page.locator(".working")).toHaveCount(0, { timeout: 15_000 });
  await noSideScroll(page, "after a reply");
  // the composer sits on the bottom edge
  const form = await page.locator(".composer").boundingBox();
  expect((form?.y ?? 0) + (form?.height ?? 0)).toBeGreaterThan(915 - 40);
});

test("the picker opens as a bottom sheet and picks a model", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await page.locator("#modelBtn").tap();
  await expectSheet(page, "#picker");
  // the search field does not grab focus, so the keyboard stays down
  await expect(page.locator("#pkSearch")).not.toBeFocused();
  const row = page.locator('#picker .pk-r[data-m="gemma4:12b"]');
  const h = (await row.boundingBox())?.height ?? 0;
  expect(h, "picker row height").toBeGreaterThanOrEqual(48);
  await expect(page.locator("#picker").getByRole("button", { name: "Close" })).toBeVisible();
  await row.tap();
  await expect(page.locator("#picker")).toBeHidden();
  await expect(page.locator("#modelBtn")).toContainText("Gemma 4 12B");

  // the sheet's close button closes it
  await page.locator("#modelBtn").tap();
  await page.locator("#picker").getByRole("button", { name: "Close" }).tap();
  await expect(page.locator("#picker")).toBeHidden();
});

test("settings opens a section and goes back to the list and the chat", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await openDrawer(page);
  await page.locator(".sb").getByRole("button", { name: "Settings" }).tap();
  const list = page.locator(".set-list");
  await expect(list).toBeVisible();
  await expect(drawerRow(page)).not.toBeInViewport();
  await list.getByRole("button", { name: "Models" }).tap();
  await expect(page.locator(".set-bar h2")).toHaveText("Models");
  await expect(list).toBeHidden();
  await page.getByRole("button", { name: "Back to Settings" }).tap();
  await expect(list).toBeVisible();
  await page.getByRole("button", { name: "Done" }).tap();
  await expect(page.locator(".hero")).toBeVisible();
});

test("every reply shows its actions, and a tap on your message shows Edit", async ({ page, open, seededThread }) => {
  await open(`#thread=${seededThread ?? ""}`);
  await waitReady(page);
  const replies = page.locator(".turn.a");
  await expect(replies.last().locator(".a-act [data-copy]")).toBeVisible();
  await expect(replies.first().locator(".a-act [data-copy]")).toBeVisible();
  const user = page.locator(".turn.u").first();
  await user.locator(".bubble").tap();
  await expect(user.locator("[data-edit]")).toBeVisible();
});

test("every control in the thread is a touch-sized target", async ({ page, open, seededThread }) => {
  await open(`#thread=${seededThread ?? ""}`);
  await waitReady(page);
  const small = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("button, [role=button], a[href], input, textarea")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden") continue;
      if (el.closest("[inert]")) continue;
      const lo = Math.min(r.width, r.height);
      const hi = Math.max(r.width, r.height);
      if (lo < 40 || hi < 44) out.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${el.className} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  });
  expect(small).toEqual([]);
});
