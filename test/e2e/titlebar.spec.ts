import type { Page } from "@playwright/test";
import { expect, test, waitReady } from "./fixtures.ts";

async function desktopOverlay(page: Page, interceptNativeControls = false): Promise<void> {
  await page.addInitScript((intercept) => {
    const overlay = new EventTarget();
    Object.assign(overlay, { visible: true });
    Object.defineProperty(navigator, "windowControlsOverlay", { value: overlay });
    // A browser stub has no native env() values; supply the same geometry fallback.
    document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.style.setProperty("--window-controls-width", "138px");
      if (intercept) {
        // Native controls own this rectangle; a transparent blocker makes a
        // browser test reject clicks that a real overlay would intercept.
        const controls = document.createElement("div");
        controls.setAttribute("aria-hidden", "true");
        Object.assign(controls.style, { position: "fixed", top: "0", right: "0", width: "138px", height: "52px", zIndex: "2147483647" });
        document.body.append(controls);
      }
    });
  }, interceptNativeControls);
}

test("desktop overlay reserves native controls, follows geometry and keeps header controls clickable", async ({ page, open }) => {
  await desktopOverlay(page);
  await open();
  await waitReady(page);
  await expect(page.locator("html")).toHaveClass(/wco/);
  const header = page.locator(".hdr");
  await expect(header).toHaveCSS("app-region", "drag");
  await expect.poll(() => header.evaluate((el) => parseFloat(getComputedStyle(el).paddingRight))).toBe(150);
  await expect(page.locator(".sb-head")).toHaveCSS("border-bottom-width", "1px");
  await page.keyboard.press("Control+Comma");
  await expect(page.locator(".set-bar")).toBeVisible();
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

for (const width of [390, 640]) {
  test(`narrow desktop Settings has a mouse route from a section back to chat at ${width}px (TB-02)`, async ({ page, open }) => {
    await page.setViewportSize({ width, height: 844 });
    await desktopOverlay(page, true);
    await open();
    await waitReady(page);
    await page.getByRole("button", { name: "Open threads", exact: true }).click();
    await page.locator(".sb-set").click();
    await expect(page.locator(".set.listing")).toBeVisible();
    await page.locator(".set-list").getByRole("button", { name: /^General/ }).click();
    await expect(page.locator(".set.listing")).toBeHidden();
    await page.getByRole("button", { name: "Back to Settings", exact: true }).click();
    await expect(page.locator(".set.listing")).toBeVisible();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await waitReady(page);
  });
}

for (const width of [320, 390]) {
  test(`drawer close stays outside the native controls at ${width}px (TB-03)`, async ({ page, open }) => {
    await page.setViewportSize({ width, height: 844 });
    await desktopOverlay(page, true);
    await open();
    await waitReady(page);
    await page.getByRole("button", { name: "Open threads", exact: true }).click();
    const sidebar = page.locator(".sb");
    await expect(sidebar).toBeVisible();
    await sidebar.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    const close = page.getByRole("button", { name: "Close threads", exact: true });
    const box = await close.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? Infinity) + (box?.width ?? 0), "close button ends before native controls").toBeLessThanOrEqual(width - 138);
    await close.click();
    await expect(sidebar).toBeHidden();
  });
}

test("ordinary browser and phone retain their original header layout", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await expect(page.locator("html")).not.toHaveClass(/wco/);
  await expect(page.locator(".hdr")).toHaveCSS("padding-right", "12px");
  await expect(page.locator(".hdr")).toHaveCSS("app-region", "none");
  await expect(page.locator(".sb-head")).toHaveCSS("border-bottom-width", "0px");
  await expect(page.locator(".set-bar")).toHaveCount(0);
  await page.keyboard.press("Control+Comma");
  await expect(page.locator(".sb-head")).toBeHidden();
  await expect(page.locator(".set-bar")).toBeHidden();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".hdr")).toHaveCSS("padding-right", "4px");
  await expect(page.locator(".hdr")).toHaveCSS("height", "52px");
});

test.describe("desktop window title and theme", () => {
  test.use({ seed: "design" });
  test("uses the thread title and resolved theme tokens, including system changes", async ({ page, open, seededThread }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "windowControlsOverlay", { value: Object.assign(new EventTarget(), { visible: true }) });
      Reflect.set(window, "titleBarColors", []);
      Reflect.set(window, "gatesLocal", {
        getServerUrl: () => Promise.resolve(new URLSearchParams(location.search).get("server")),
        onState: () => () => {},
        syncTitleBar: (colors: unknown) => { Reflect.get(window, "titleBarColors").push(colors); return Promise.resolve(); },
      });
    });
    await open(`#thread=${seededThread}`);
    await waitReady(page);
    await expect(page).toHaveTitle("Library: Effect Schema books · Gates Local");
    const colors = () => page.evaluate(() => Reflect.get(window, "titleBarColors").at(-1) as { color: string; symbolColor: string });
    await expect.poll(colors).toEqual({ color: "#0a0a0a", symbolColor: "#f2f2f2" });
    await page.keyboard.press("Control+Comma");
    const theme = page.getByRole("group", { name: "Theme", exact: true });
    await theme.getByRole("button", { name: "Light", exact: true }).click();
    await expect.poll(colors).toEqual({ color: "#fcfcfc", symbolColor: "#171717" });
    await theme.getByRole("button", { name: "System", exact: true }).click();
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(colors).toEqual({ color: "#fcfcfc", symbolColor: "#171717" });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(colors).toEqual({ color: "#0a0a0a", symbolColor: "#f2f2f2" });
  });
});
