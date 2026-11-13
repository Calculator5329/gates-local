/// <reference lib="dom" />
// The queue tray (chat rows 19 and 14): a message queued while a picture is
// being made sits in a tray on the composer's top edge, says what it will make
// with an icon, and names only what is true; its actions are icons. Editing a
// queued message while a reply runs moves nothing in the composer's row: Stop
// takes Dictate's square. Each state is shot at desktop and phone width, dark
// and light, with the boxes of what the shot is about beside it.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { fakeComfy } from "./fake-comfy.ts";
import { FAKE_URL } from "./env.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

test.use({ video: "off", allowedErrors: [/WebSocket connection to .* failed/] });

const WIDE = { width: 1920, height: 1080 };
const PHONE = { width: 390, height: 844 };
const PICTURE = "A lighthouse on a cliff at dusk";
const NEXT = "Sci-fi battle, HD, realistic, many ships in action fighting and shooting";

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

test.describe("a message queued while a picture is being made", () => {
  let comfy: Awaited<ReturnType<typeof fakeComfy>>;
  test.beforeEach(async () => { comfy = await fakeComfy(); });
  test.afterEach(async () => { await comfy.close(); });
  test.use({ viewport: WIDE });

  test("sits on the composer's top edge as one line: what it makes, its words, and three icons whose tips are true", async ({ page, open }) => {
    await stack.reset("image-turn", 0, undefined, "system", undefined, comfy.url);
    await open(); await waitReady(page);
    await page.keyboard.press("Control+Comma");
    await page.locator(".snav").getByRole("button", { name: "Image generation", exact: true }).click();
    await page.getByRole("switch", { name: "Generate images" }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Image", exact: true }).click();
    await sendMessage(page, PICTURE);
    await expect(page.locator("[data-image-job]")).toContainText("Making image");
    await sendMessage(page, NEXT);

    const tray = page.locator(".qt");
    const row = page.locator(".qt-r");
    await expect(row).toHaveCount(1);
    const marks = { tray, composer: page.locator(".composer"), row };
    // every shot first, so a red run still shows each size and theme
    const seen: [number, { x: number; y: number; width: number; height: number }, { x: number; y: number; width: number; height: number }][] = [];
    for (const size of [WIDE, PHONE]) {
      await page.setViewportSize(size);
      for (const scheme of ["dark", "light"] as const) {
        await theme(page, scheme);
        await shoot(page, `image-queue-${size.width}-${scheme}`, marks);
      }
      seen.push([size.width, (await tray.boundingBox())!, (await page.locator(".composer").boundingBox())!]);
    }
    for (const [width, t, c] of seen) {
      expect(t.x, `the tray starts inside the composer's width at ${width} px`).toBeGreaterThanOrEqual(c.x);
      expect(t.x + t.width, `the tray ends inside the composer's width at ${width} px`).toBeLessThanOrEqual(c.x + c.width);
      expect(Math.abs(t.y + t.height - c.y), `the tray sits on the composer's top edge at ${width} px`).toBeLessThanOrEqual(1);
    }
    await page.setViewportSize(WIDE);
    await theme(page, "dark");

    // what it will make, as an icon and in its name
    await expect(row).toHaveAttribute("aria-label", "Queued image 1 of 1");
    await expect(row.locator(".qt-k use")).toHaveAttribute("href", "#i-image");
    // waiting in the queue says it waits: no status words, only the message
    await expect(row).toHaveText(NEXT);
    // the actions are icons, and Send now says what it stops
    for (const name of ["Send now", "Edit", "Remove"]) await expect(row.getByRole("button", { name, exact: true })).toHaveText("");
    await expect(row.getByRole("button", { name: "Send now", exact: true })).toHaveAttribute("data-tip", "Send now. Cancels the image");
    await expect(page.locator(".composer button.send"), "the composer's Stop names the picture too").toHaveAttribute("data-tip", "Cancel the image. Enter queues your message after it");
    comfy.finish();
  });
});

test.describe("editing a queued message while a reply runs", () => {
  test.use({ viewport: WIDE });

  test("moves nothing in the composer's row: Stop takes Dictate's square", async ({ page, open }) => {
    await open(); await waitReady(page);
    await stack.scenario("slow-drip", { holdAfterTokens: 46 });
    await sendMessage(page, "How do I check disk space before a download?");
    await expect(page.locator(".turn.a .md ul li")).toHaveCount(3, { timeout: 15_000 });
    await sendMessage(page, "And on a second drive?");
    await expect(page.locator(".qt-r")).toHaveCount(1);

    const row = page.locator(".composer .cf-r");
    const edges = () => row.evaluate((r) => [...r.children].filter((e) => e.getClientRects().length > 0).map((e) => {
      const b = e.getBoundingClientRect();
      return [Math.round(b.left * 10) / 10, Math.round(b.right * 10) / 10];
    }));
    const marks = { row, voice: page.locator(".composer .voice"), stop: page.locator(".composer .stop-sq"), model: page.locator("#modelBtn"), edit: page.locator(".qt-r [data-edit-queued]") };
    for (const scheme of ["dark", "light"] as const) { await theme(page, scheme); await shoot(page, `edit-queued-before-click-${scheme}`, marks); }
    const running = await edges();
    await page.locator(".qt-r [data-edit-queued]").click();
    await expect(page.locator(".composer button.send")).toHaveAccessibleName("Update queued message");
    for (const scheme of ["dark", "light"] as const) { await theme(page, scheme); await shoot(page, `edit-queued-after-click-${scheme}`, marks); }
    expect(await edges(), "the pencil moves no control in the row").toEqual(running);
    const stop = page.locator(".composer .stop-sq");
    await expect(stop).toHaveAccessibleName("Stop");
    await expect(page.locator(".composer .voice"), "Stop is in Dictate's square").toHaveCount(0);

    await fetch(`${FAKE_URL}/__fake/release`, { method: "POST", body: "{}" });
    await expect(stop).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator(".composer .voice")).toBeVisible();
    expect(await edges(), "the reply ending moves no control in the row").toEqual(running);
  });
});
