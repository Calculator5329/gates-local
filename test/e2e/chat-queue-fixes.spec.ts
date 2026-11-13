/// <reference lib="dom" />
// Review fixes for the queue tray (CQ-01 to CQ-04). While a queued message is
// edited during a reply, Stop sits in Dictate's square; when the reply ends,
// Dictate comes back under the pointer. The rest of a double-click on Stop must
// not land on Dictate (it would open Settings, or the microphone). Dictate's
// shortcut stays alive while Stop holds its square and says why it waits. The
// tray's status line is always in the tree. A stopped first download reads as
// two words on a phone, with the sentence as the tip.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { FAKE_URL } from "./env.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

test.use({ video: "off" });

const WIDE = { width: 1920, height: 1080 };
const PHONE = { width: 390, height: 844 };
const HELD = "Dictate comes back when this reply ends or you finish editing the queued message.";

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

/** Counts microphone asks (none may happen in these tests); call before open. */
async function countMic(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { micAsks: number };
    w.micAsks = 0;
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => { w.micAsks++; return Promise.reject(new DOMException("test", "NotAllowedError")); };
  });
}

/** A reply runs and holds; a second message waits in the tray. */
async function replyWithQueue(page: Page): Promise<void> {
  await waitReady(page);
  await stack.scenario("slow-drip", { holdAfterTokens: 46 });
  await sendMessage(page, "How do I check disk space before a download?");
  await expect(page.locator(".turn.a .md ul li")).toHaveCount(3, { timeout: 15_000 });
  await sendMessage(page, "And on a second drive?");
  await expect(page.locator(".qt-r")).toHaveCount(1);
}

const mic = (page: Page) => page.evaluate(() => (window as unknown as { micAsks: number }).micAsks);

test.describe("editing a queued message while a reply runs", () => {
  test.use({ viewport: WIDE });

  for (const [press, second] of [["a double-click", 2], ["a quick second click", 1]] as const) {
    test(`CQ-01: ${press} on Stop as the reply ends stays in the chat: no Settings, no microphone`, async ({ page, open }) => {
      await countMic(page); await open(); await replyWithQueue(page);
      await page.locator(".qt-r [data-edit-queued]").click();
      const stop = page.locator(".composer .stop-sq");
      await expect(stop).toHaveAccessibleName("Stop");
      const box = (await stop.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down({ clickCount: 1 }); await page.mouse.up({ clickCount: 1 });
      // the reply stops and Dictate takes the square back under the pointer
      await page.locator(".composer .voice").waitFor();
      await page.mouse.down({ clickCount: second }); await page.mouse.up({ clickCount: second });
      await page.waitForTimeout(500);
      await shoot(page, `cq01-after-${second}`, { square: page.locator(".composer .voice"), composer: page.locator(".composer") });
      await expect(page.locator(".snav"), "Settings stays closed").toHaveCount(0);
      await expect(page.locator(".composer")).toBeVisible();
      expect(await mic(page), "the microphone was not asked for").toBe(0);
      await expect(page.locator(".composer .voice")).toHaveAttribute("aria-pressed", "false");
      // a fresh press, after the guard, is Dictate's again
      await page.waitForTimeout(400);
      await page.locator(".composer .voice").click();
      await expect(page.locator(".snav"), "a later press on Dictate still works").toBeVisible();
    });
  }

  test("CQ-02 and CQ-03: the tray's status is in the tree while it waits; Dictate's shortcut says why it waits while Stop holds its square", async ({ page, open }) => {
    await countMic(page); await open(); await replyWithQueue(page);
    const status = page.locator(".qt-r .qt-s");
    await expect(status, "the status line is there while the message just waits").toHaveCount(1);
    await expect(status).toHaveAttribute("role", "status");
    await expect(status).toHaveText("");

    await page.locator(".qt-r [data-edit-queued]").click();
    await expect(page.locator(".composer .stop-sq")).toBeVisible();
    await expect(status).toHaveText("Editing");
    await page.keyboard.press("Control+Shift+Space");
    await expect(page.locator(".c-note"), "the shortcut says why dictation waits").toHaveText(HELD);
    await shoot(page, "cq02-held-note", { note: page.locator(".c-note"), stop: page.locator(".composer .stop-sq") });
    expect(await mic(page)).toBe(0);
    await expect(page.locator(".snav")).toHaveCount(0);

    await fetch(`${FAKE_URL}/__fake/release`, { method: "POST", body: "{}" });
    await expect(page.locator(".composer .stop-sq")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator(".composer .voice")).toBeVisible();
    // Dictate is back, so the note that said why it waited goes with it (CQ-05)
    await expect(page.locator(".c-note"), "the held note is gone once Dictate is back").toHaveCount(0);
    // the shortcut is Dictate's again: without a whisper.cpp address it opens Settings
    await page.keyboard.press("Control+Shift+Space");
    await expect(page.locator(".snav")).toBeVisible();
  });

  test("CQ-09: Cancel editing takes Dictate's held note with it, while the reply still runs", async ({ page, open }) => {
    await countMic(page); await open(); await replyWithQueue(page);
    await page.locator(".qt-r [data-edit-queued]").click();
    await expect(page.locator(".composer .stop-sq")).toBeVisible();
    await page.keyboard.press("Control+Shift+Space");
    await expect(page.locator(".c-note")).toHaveText(HELD);

    await page.getByRole("button", { name: "Cancel editing" }).click();
    await expect(page.locator(".composer .stop-sq"), "Stop is back on the main button").toHaveCount(0);
    await expect(page.locator(".composer .voice")).toBeVisible();
    await expect(page.locator(".c-note"), "the note that said Dictate waits is gone once the edit is cancelled").toHaveCount(0);
    expect(await mic(page)).toBe(0);
  });
});

test.describe("a message waiting on a first download that stopped", () => {
  test.use({ scenario: "no-models", skipFirstRun: false, viewport: WIDE });

  test("CQ-04: reads Download stopped on a phone, whole, with the sentence as its tip", async ({ page, open }) => {
    await open();
    // a slow pull, so it can be cancelled from the chat
    await stack.scenario("no-models", { pullTickMs: 2000 });
    await page.getByRole("button", { name: "Download and start" }).click();
    await page.getByRole("button", { name: "Start chatting" }).click();
    await sendMessage(page, "Hello there");
    await expect(page.locator(".qt-r")).toContainText("After download");
    // the sidebar's Models entry shows the download and opens Settings › Models, which can cancel it
    await page.getByRole("button", { name: /^Models · Downloading/ }).click();
    await page.getByRole("button", { name: "Cancel download" }).first().click();
    await page.getByRole("button", { name: "Back to chat" }).click();
    await expect(page.locator(".snav")).toHaveCount(0);
    const status = page.locator(".qt-r .qt-s");
    await expect(status).not.toHaveText("After download");
    await page.setViewportSize(PHONE);
    const marks = { tray: page.locator(".qt"), status };
    for (const scheme of ["dark", "light"] as const) { await theme(page, scheme); await shoot(page, `cq04-stopped-390-${scheme}`, marks); }
    await expect(status).toHaveText("Download stopped");
    await expect(status).toHaveAttribute("data-tip", "Download stopped. Download a model to send this.");
    const fit = await status.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(fit.scroll, "the word is whole at 390 px").toBeLessThanOrEqual(fit.client);
  });
});
