/// <reference lib="dom" />
// The start screen, direction Mark (chat row 20): the gate mark above the bar
// in the accent colour (the theme's foreground until Settings defines one),
// the bar as it was, and under it only what is not set up yet: the library's
// icon and the image's, each with an amber ring, each opening its Settings
// section. A set-up machine shows the mark and the bar and nothing else.
import { writeFileSync } from "node:fs";
import { createClient } from "@gates-local/contracts";
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

async function setUp(page: Page, what: { library?: string; images?: boolean }): Promise<void> {
  const server = new URL(page.url()).searchParams.get("server");
  if (!server) throw new Error("No test server");
  const client = createClient(new WebSocket(server));
  try {
    if (what.library !== undefined) {
      writeFileSync(what.library, "Notes on cron.\n");
      await client.call("sources.add", { kind: "file", path: what.library });
    }
    if (what.images) await client.call("settings.update", { imageGen: true });
  } finally {
    client.close();
  }
  await page.reload();
  await waitReady(page);
}

test.describe("the start screen", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  // Guards the owner's pick of the Mark start screen: no headline or cards, the mark in the accent, an icon per thing not set up.
  test("a new install: the mark above the bar, and the library and image icons with amber rings under it", async ({ page, open }) => {
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

    const icons = page.locator(".setup-row .setup-ic");
    await expect(icons).toHaveCount(2);
    await expect(icons.nth(0)).toHaveAccessibleName("Set up library search");
    await expect(icons.nth(0)).toHaveAttribute("data-tip", "Library search");
    await expect(icons.nth(1)).toHaveAccessibleName("Set up image generation");
    await expect(icons.nth(1)).toHaveAttribute("data-tip", "Image generation");
    await expect(icons.locator(".unset")).toHaveCount(2);

    await icons.nth(0).click();
    await expect(page.locator(".snav .sb-act.on")).toHaveText("Library");
    await page.keyboard.press("Escape");
    await waitReady(page);
    await page.getByTestId("chat.setup.open-images").click();
    await expect(page.locator(".snav .sb-act.on")).toHaveText("Image generation");
  });

  // Guards the owner's rules to show only what is true and that nothing moves: set-up icons go, the bar stays put.
  test("images set up: only the library icon is left; everything set up: the mark and the bar, nothing else, the bar where it was", async ({ page, open }) => {
    await open();
    await waitReady(page);
    const before = await page.locator(".draft .composer").boundingBox();

    await setUp(page, { images: true });
    await expect(page.locator(".setup-row .setup-ic")).toHaveCount(1);
    await expect(page.locator(".setup-row .setup-ic")).toHaveAccessibleName("Set up library search");

    await setUp(page, { library: test.info().outputPath("notes.txt") });
    await expect(page.locator(".setup-row .setup-ic")).toHaveCount(0);
    await expect(page.locator(".draft-in > :visible")).toHaveCount(2); // the mark and the bar's slot
    const after = await page.locator(".draft .composer").boundingBox();
    expect(after?.y, "the bar does not move when the icons go").toBe(before?.y);
  });
});
