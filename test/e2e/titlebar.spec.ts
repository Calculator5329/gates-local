import type { Page } from "@playwright/test";
import { expect, test, waitReady } from "./fixtures.ts";

async function desktopOverlay(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const overlay = new EventTarget();
    Object.assign(overlay, { visible: true });
    Object.defineProperty(navigator, "windowControlsOverlay", { value: overlay });
    // A browser stub has no native env() values; supply the same geometry fallback.
    document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.style.setProperty("--window-controls-width", "138px");
    });
  });
}

// Guards the owner's ask for a title bar built into the app like T3 Code's, with the window controls kept clear.
test("desktop overlay reserves native controls, follows geometry and keeps header controls clickable", async ({ page, open }) => {
  await desktopOverlay(page);
  await open();
  await waitReady(page);
  await expect(page.locator("html")).toHaveClass(/wco/);
  const header = page.locator(".hdr");
  await expect(header).toHaveCSS("app-region", "drag");
  await expect.poll(() => header.evaluate((el) => parseFloat(getComputedStyle(el).paddingRight))).toBe(150);
  // Settings is a pop-up over the window: the chat's header stays, no Settings bar of its own
  await page.keyboard.press("Control+Comma");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await expect(page.locator(".hdr")).toHaveCSS("app-region", "drag");
  await expect(page.locator(".set-bar")).toHaveCount(0);
  await expect(page.locator(".sb-head")).toBeVisible();
  await page.keyboard.press("Escape");
  for (const width of [900, 600]) {
    await page.setViewportSize({ width, height: 800 });
    await page.getByRole("button", { name: "Open threads", exact: true }).click();
    await expect(page.locator(".sb")).toBeVisible();
    await page.getByRole("button", { name: "Close threads", exact: true }).click();
  }
  await page.evaluate(() => {
    const overlay = Reflect.get(navigator, "windowControlsOverlay") as EventTarget & { visible: boolean };
    overlay.visible = false;
    overlay.dispatchEvent(new Event("geometrychange"));
  });
  await expect(page.locator("html")).not.toHaveClass(/wco/);
});
