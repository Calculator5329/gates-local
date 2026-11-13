/// <reference lib="dom" />
// The top of the sidebar: no line under the sidebar head in the desktop
// titlebar layout, in chat or in Settings. The one line that stays is the
// divider between the sidebar and the chat.
import type { Page } from "@playwright/test";
import { expect, test, waitReady } from "./fixtures.ts";

test.use({ video: "off", viewport: { width: 1920, height: 1080 } });

/** A browser stub of the desktop window controls overlay, as in titlebar.spec.ts. */
async function desktopOverlay(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const overlay = new EventTarget();
    Object.assign(overlay, { visible: true });
    Object.defineProperty(navigator, "windowControlsOverlay", { value: overlay });
    document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.style.setProperty("--window-controls-width", "138px");
    });
  });
}

async function theme(page: Page, scheme: "dark" | "light"): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
}

type Lines = { head: string[]; below: string[]; divider: { width: string; style: string; color: string } };

/** Every way something could draw a line under the sidebar head, and the sidebar's right edge. */
function lines(page: Page): Promise<Lines> {
  return page.locator(".sb").evaluate((sb) => {
    const head = sb.querySelector(".sb-head");
    const below = sb.querySelector(".sb-body");
    if (!head || !below) throw new Error("no sidebar head or body");
    const drawn: string[] = [];
    const css = getComputedStyle(head);
    if (css.borderBottomStyle !== "none" && parseFloat(css.borderBottomWidth) > 0) drawn.push(`border-bottom ${css.borderBottomWidth}`);
    if (css.boxShadow !== "none") drawn.push(`box-shadow ${css.boxShadow}`);
    for (const p of ["::before", "::after"]) if (getComputedStyle(head, p).content !== "none") drawn.push(`${p} drawn`);
    const under: string[] = [];
    for (const el of [below, ...below.querySelectorAll(":scope > *")].slice(0, 2)) {
      const c = getComputedStyle(el);
      if (c.borderTopStyle !== "none" && parseFloat(c.borderTopWidth) > 0) under.push(`${el.className} border-top ${c.borderTopWidth}`);
    }
    const s = getComputedStyle(sb);
    return { head: drawn, below: under, divider: { width: s.borderRightWidth, style: s.borderRightStyle, color: s.borderRightColor } };
  });
}

async function noLineUnderHead(page: Page, where: string): Promise<void> {
  const l = await lines(page);
  expect(l.head, `${where}: nothing draws a line under the sidebar head`).toEqual([]);
  expect(l.below, `${where}: nothing draws a line on top of the sidebar body`).toEqual([]);
  expect(l.divider.width, `${where}: the sidebar and the chat keep their divider`).toBe("1px");
  expect(l.divider.style).toBe("solid");
  expect(l.divider.color).not.toBe("rgba(0, 0, 0, 0)");
}

// Guards the owner's report: a line showed under the sidebar head.
test("the desktop sidebar head has no line under it in chat or Settings; the sidebar/chat divider stays", async ({ page, open }) => {
  await desktopOverlay(page);
  await open();
  await waitReady(page);
  await expect(page.locator("html")).toHaveClass(/wco/);
  for (const scheme of ["dark", "light"] as const) {
    await theme(page, scheme);
    await noLineUnderHead(page, `desktop chat, ${scheme}`);
  }
  await page.keyboard.press("Control+Comma");
  await expect(page.locator(".set-bar")).toBeVisible();
  await noLineUnderHead(page, "desktop Settings");
});
