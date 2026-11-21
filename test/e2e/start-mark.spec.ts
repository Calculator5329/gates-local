/// <reference lib="dom" />
// The start screen, direction Mark (chat row 20): the gate mark above the bar
// in the accent colour (the theme's foreground until Settings defines one),
// the bar as it was, and nothing else. The set-up icons that sat under the bar
// left on 2026-11-21; the plus menu offers the same two.
import type { Page } from "@playwright/test";
import { expect, test, waitReady } from "./fixtures.ts";

const SCHEMES = ["dark", "light"] as const;
const OLD = ".hero, .hero-sub, .cards, .card-links";

async function theme(page: Page, scheme: "dark" | "light"): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
}

/** The resolved colour a probe takes from `value` in the page's current theme. */
function resolve(page: Page, value: string): Promise<string> {
  return page.evaluate((v) => {
    const probe = document.createElement("span");
    probe.style.color = v;
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, value);
}

test.describe("the start screen", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  // Guards the owner's pick of the Mark start screen: no headline or cards, the mark in the accent, nothing under the bar.
  test("a new install: the mark above the bar, and nothing else", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await expect(page.locator(".draft .composer")).toBeVisible();

    await expect(page.locator(OLD), "no headline, subline, cards or set-up links").toHaveCount(0);
    await expect(page.getByText("What would you like help with?")).toHaveCount(0);
    const mark = page.locator(".draft").getByRole("heading", { name: "Gates Local" });
    await expect(mark).toBeVisible();

    for (const scheme of SCHEMES) {
      await theme(page, scheme);
      expect(await page.locator(".start-mark").evaluate((e) => getComputedStyle(e).color), `${scheme}: the mark falls back to the foreground`).toBe(await resolve(page, "var(--foreground)"));
    }
    await page.evaluate(() => document.documentElement.style.setProperty("--accent", "rgb(1, 2, 3)"));
    await expect(page.locator(".start-mark"), "the mark follows --accent once Settings defines it").toHaveCSS("color", "rgb(1, 2, 3)");
    await page.evaluate(() => document.documentElement.style.removeProperty("--accent"));

    // set-up icons left 2026-11-21: the plus menu offers library search and image generation
    await expect(page.locator(".draft-in > :visible")).toHaveCount(2); // the mark and the bar's slot
  });
});
