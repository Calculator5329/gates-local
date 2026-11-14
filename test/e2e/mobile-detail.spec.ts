/// <reference lib="dom" />
// Settings on a phone and the model rows' Remove. mobile.spec.ts has the whole
// phone journeys.
import type { Page } from "@playwright/test";
import { expect, listButton, openModels, test, waitReady } from "./fixtures.ts";

/** Thu 2026-11-12 14:00 in Chicago, as in the screenshot rig. */
const NOW = Date.UTC(2026, 10, 12, 20, 0);
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true };
const NARROW = { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true };

test.use({ seed: "design", seedAt: NOW, timezoneId: "America/Chicago", locale: "en-US" });

async function openDrawer(page: Page): Promise<void> {
  await page.getByTestId("chat.header.open-threads").tap();
  await expect(page.locator(".sb .sb-row").first()).toBeInViewport({ ratio: 1 });
}

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

for (const [width, use] of [["412", PHONE], ["360", NARROW]] as const) {
  test.describe(`Settings at ${width}`, () => {
    test.use(use);

    // Guards the owner's ruling: Remove lives in a model row's ⋯ menu.
    test("Remove stays in a row's ⋯ menu, 44 px to reach and on the screen", async ({ page, open }) => {
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
      const remove = row.getByRole("menuitem", { name: /^Remove…/ });
      await expect(remove).toBeInViewport({ ratio: 1 });
      await remove.tap();
      await page.getByRole("dialog").locator(".mp-danger").tap();
      await expect(row).toHaveCount(0);
    });
  });
}

test.describe("the desktop's model rows", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  // Guards the owner's ruling: Remove lives in a model row's ⋯ menu.
  test("Remove is in the row's ⋯ menu and nowhere under the row", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await openModels(page);
    const row = page.locator('.mp-row[data-dm="gemma4:12b"]');
    await expect(row).toBeVisible();
    await expect(page.locator(".mp")).not.toContainText("Remove");
    await row.getByTestId("models.row-menu.open").click();
    await expect(row.getByTestId("models.row-menu.remove")).toBeVisible();
  });
});
