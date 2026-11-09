import { expect, test, waitReady } from "./fixtures.ts";

test("desktop overlay reserves native controls, follows geometry and keeps header controls clickable", async ({ page, open }) => {
  await page.addInitScript(() => {
    const overlay = new EventTarget();
    Object.assign(overlay, { visible: true });
    Object.defineProperty(navigator, "windowControlsOverlay", { value: overlay });
    // A browser stub has no native env() values; supply the same geometry fallback.
    document.addEventListener("DOMContentLoaded", () => document.documentElement.style.setProperty("--window-controls-width", "138px"));
  });
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
