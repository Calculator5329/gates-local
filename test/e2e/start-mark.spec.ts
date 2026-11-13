/// <reference lib="dom" />
// The start screen, direction Mark (chat row 20): the gate mark above the bar
// in the accent colour (the theme's foreground until Settings defines one),
// the bar as it was, and under it only what is not set up yet: the library's
// icon and the image's, each with an amber ring, each opening its Settings
// section. A set-up machine shows the mark and the bar and nothing else.
// Each state is shot at desktop and phone width, dark and light, with the
// boxes of what the shot is about beside it.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@gates-local/contracts";
import type { Locator, Page } from "@playwright/test";
import { expect, test, waitReady } from "./fixtures.ts";

test.use({ video: "off" });

const WIDE = { width: 1920, height: 1080 };
const PHONE = { width: 390, height: 844 };
const SIZES = [["1920", WIDE], ["390", PHONE]] as const;
const SCHEMES = ["dark", "light"] as const;
const OLD = ".hero, .hero-sub, .cards, .card-links";

/** A screenshot and the boxes of the things it is about, for the report's highlights. */
async function shoot(page: Page, name: string, marks: Record<string, Locator>): Promise<void> {
  const file = test.info().outputPath(`${name}.png`);
  mkdirSync(path.dirname(file), { recursive: true });
  const boxes: Record<string, unknown> = {};
  for (const [k, l] of Object.entries(marks)) boxes[k] = (await l.count()) > 0 ? await l.first().boundingBox() : null;
  await page.screenshot({ path: file, animations: "disabled" });
  writeFileSync(test.info().outputPath(`${name}.json`), JSON.stringify(boxes));
}

async function theme(page: Page, scheme: "dark" | "light"): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
}

const marks = (page: Page) => ({
  mark: page.locator(".start-mark"),
  composer: page.locator(".draft .composer"),
  row: page.locator(".setup-row"),
  icons: page.locator(".setup-row .setup-ic"),
  old: page.locator(OLD),
});

/** Every size and theme of the start screen as it is now, before any assertion, so a red run still shows them all. */
async function shootAll(page: Page, state: string): Promise<void> {
  for (const [w, size] of SIZES) {
    await page.setViewportSize(size);
    for (const scheme of SCHEMES) {
      await theme(page, scheme);
      await shoot(page, `start-${state}-${w}-${scheme}`, marks(page));
    }
  }
  await page.setViewportSize(WIDE);
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
  test.use({ viewport: WIDE });

  test("a new install: the mark above the bar, and the library and image icons with amber rings under it", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await expect(page.locator(".draft .composer")).toBeVisible();
    await shootAll(page, "new");

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

    const m = await page.locator(".start-mark").boundingBox();
    const c = await page.locator(".draft .composer").boundingBox();
    if (!m || !c) throw new Error("no mark or composer");
    expect(m.width, "the mark is 34 px").toBe(34);
    expect(Math.round(c.y - (m.y + m.height)), "the mark sits 28 px above the bar").toBe(28);
    expect(Math.abs(m.x + m.width / 2 - (c.x + c.width / 2)), "the mark is centred on the bar").toBeLessThanOrEqual(1);

    const icons = page.locator(".setup-row .setup-ic");
    await expect(icons).toHaveCount(2);
    await expect(icons.nth(0)).toHaveAccessibleName("Set up library search");
    await expect(icons.nth(0)).toHaveAttribute("data-tip", "Library search");
    await expect(icons.nth(1)).toHaveAccessibleName("Set up image generation");
    await expect(icons.nth(1)).toHaveAttribute("data-tip", "Image generation");
    await expect(icons.locator(".unset")).toHaveCount(2);
    const r = await page.locator(".setup-row").boundingBox();
    expect(Math.round((r?.y ?? 0) - (c.y + c.height)), "the icons sit 16 px under the bar").toBe(16);

    await icons.nth(0).click();
    await expect(page.locator(".snav .sb-act.on")).toHaveText("Library");
    await page.keyboard.press("Escape");
    await waitReady(page);
    await page.locator(".setup-row .setup-ic").nth(1).click();
    await expect(page.locator(".snav .sb-act.on")).toHaveText("Image generation");
  });

  test("images set up: only the library icon is left; everything set up: the mark and the bar, nothing else, the bar where it was", async ({ page, open }) => {
    await open();
    await waitReady(page);
    const before = await page.locator(".draft .composer").boundingBox();

    await setUp(page, { images: true });
    await shootAll(page, "lib");
    await expect(page.locator(".setup-row .setup-ic")).toHaveCount(1);
    await expect(page.locator(".setup-row .setup-ic")).toHaveAccessibleName("Set up library search");

    await setUp(page, { library: test.info().outputPath("notes.txt") });
    await shootAll(page, "done");
    await expect(page.locator(".setup-row .setup-ic")).toHaveCount(0);
    await expect(page.locator(".draft-in > :visible")).toHaveCount(2); // the mark and the bar's slot
    const after = await page.locator(".draft .composer").boundingBox();
    expect(after?.y, "the bar does not move when the icons go").toBe(before?.y);
  });
});

test.describe("the start screen on a phone", () => {
  test.use({ viewport: PHONE, isMobile: true, hasTouch: true });

  test("the mark sits over the docked bar, the setup icons just above it, each a 44 px target", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await expect(page.locator(".draft").getByRole("heading", { name: "Gates Local" })).toBeVisible();
    const icons = page.locator(".setup-row .setup-ic");
    await expect(icons).toHaveCount(2);
    const m = await page.locator(".start-mark").boundingBox();
    const r = await page.locator(".setup-row").boundingBox();
    const c = await page.locator(".draft .composer").boundingBox();
    if (!m || !r || !c) throw new Error("no mark, row or composer");
    expect(r.y, "the icons sit under the mark").toBeGreaterThan(m.y + m.height);
    expect(c.y - (r.y + r.height), "the icons end just above the bar").toBeLessThanOrEqual(28);
    for (const b of await icons.all()) expect((await b.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await icons.first().tap();
    await expect(page.locator(".set-bar h2")).toHaveText("Library");
  });
});
