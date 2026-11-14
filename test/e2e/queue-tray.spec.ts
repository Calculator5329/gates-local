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
  // a GPU, so the picture is really being made: on the CPU an unset send is refused at once
  test.beforeEach(async () => { comfy = await fakeComfy(); comfy.gpu(); });
  test.afterEach(async () => { await comfy.close(); });
  test.use({ viewport: WIDE });

  // Guards the owner's ruling on the queue tray (chat row 19): one line on the composer's edge, icons with true tips.
  test("sits on the composer's top edge as one line: what it makes, its words, and three icons whose tips are true", async ({ page, open }) => {
    await stack.reset("image-turn", 0, undefined, "system", undefined, comfy.url);
    await open(); await waitReady(page);
    await page.keyboard.press("Control+Comma");
    await page.getByTestId("settings.nav.open-images").click();
    await page.getByTestId("settings.images.enable").click();
    await page.keyboard.press("Escape");
    await page.getByTestId("chat.composer.image").click();
    await sendMessage(page, PICTURE);
    await expect(page.locator("[data-image-job]").getByRole("status", { name: /Making image/ })).toBeVisible();
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
    // chat row 36, owner pick A: a shelf inside the message box, at its width, on its top
    await expect(page.locator(".composer .qt"), "the shelf is in the box").toHaveCount(1);
    for (const [width, t, c] of seen) {
      expect(Math.abs(t.x - c.x), `the shelf starts at the box's left edge at ${width} px`).toBeLessThanOrEqual(1);
      expect(Math.abs(t.width - c.width), `the shelf is the box's width at ${width} px`).toBeLessThanOrEqual(1);
      expect(Math.abs(t.y - c.y), `the shelf is the box's top at ${width} px`).toBeLessThanOrEqual(1);
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
    await expect(row.getByTestId("chat.queue.send-now-1")).toHaveAttribute("data-tip", "Send now. Cancels the image");
    await expect(page.locator(".composer button.send"), "the composer's Stop names the picture too").toHaveAttribute("data-tip", "Cancel image");
    comfy.finish();
  });
});

test.describe("editing a queued message while a reply runs", () => {
  test.use({ viewport: WIDE });

  // Guards the owner's decision (chat row 14): editing a queued message, Stop takes Dictate's square and nothing moves.
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

  // Guards the owner's pick (chat row 36, A): more than three queued fold to the next two and a count.
  test("more than three queued fold to the next two and a count that opens the rest", async ({ page, open }) => {
    await open(); await waitReady(page);
    await stack.scenario("slow-drip", { holdAfterTokens: 46 });
    await sendMessage(page, "How do I check disk space before a download?");
    await expect(page.locator(".turn.a .md ul li")).toHaveCount(3, { timeout: 15_000 });
    for (const n of [1, 2, 3, 4]) await sendMessage(page, `Queued ${n}`);
    const rows = page.locator(".composer .qt-r");
    const more = page.getByTestId("chat.queue.more");
    await expect(rows).toHaveText(["Queued 1", "Queued 2"]);
    await expect(more).toHaveText("+2");
    const marks = { shelf: page.locator(".composer .qt"), more };
    for (const scheme of ["dark", "light"] as const) { await theme(page, scheme); await shoot(page, `queue-folded-${scheme}`, marks); }
    await more.click();
    await expect(rows).toHaveText(["Queued 1", "Queued 2", "Queued 3", "Queued 4"]);
    await expect(more).toHaveAttribute("aria-expanded", "true");
    for (const scheme of ["dark", "light"] as const) { await theme(page, scheme); await shoot(page, `queue-open-${scheme}`, marks); }
    await fetch(`${FAKE_URL}/__fake/release`, { method: "POST", body: "{}" });
  });
});
