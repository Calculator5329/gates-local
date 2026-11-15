/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test, waitReady } from "./fixtures.ts";

interface ClipboardProbe {
  read: () => Promise<string>;
  write: (text: string) => Promise<void>;
}

declare global {
  interface Window {
    copyProbe: ClipboardProbe;
  }
}

test.use({ seed: 2, permissions: ["clipboard-read", "clipboard-write"], video: process.env["GL_E2E_RECORD"] || process.env["GL_FLICKER_MEASURE"] ? "on" : "off" });

/** Keep the native reader: assertions check the browser's clipboard, not a copy mock. */
async function limitClipboard(page: Page, mode: "rejected" | "missing") {
  await page.addInitScript((limit) => {
    window.copyProbe = { read: navigator.clipboard.readText.bind(navigator.clipboard), write: navigator.clipboard.writeText.bind(navigator.clipboard) };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: limit === "missing" ? undefined : { writeText: () => Promise.reject(new DOMException("Clipboard denied", "NotAllowedError")) },
    });
  }, mode);
}

const replyText = [
  "Here is the short version.", "", "- **cron** reads its own `PATH`, not your shell's",
  "- set it at the top of the crontab, or use full paths", "", "```sh",
  "PATH=/usr/local/bin:/usr/bin:/bin", "```", "",
  "That covers most cases where a job runs by hand but not on schedule.",
].join("\n");

for (const mode of ["rejected", "missing"] as const) {
  // Guards the owner's report: the copy icons did not copy.
  test(`copy each content type when the clipboard API is ${mode}`, async ({ page, open, seededThread }) => {
      await limitClipboard(page, mode);
      await open(`#thread=${seededThread ?? ""}`);
      await waitReady(page);
      for (const target of ["user message", "reply", "code"] as const) await test.step(`copy exact ${target} text`, async () => {
      await page.evaluate(() => window.copyProbe.write("clipboard sentinel"));
      const turn = page.locator(target === "user message" ? ".turn.u" : ".turn.a").last();
      const copy = target === "code" ? turn.getByTestId("chat.markdown.copy-code") : turn.locator("[data-copy]");
      const expected = target === "code" ? "PATH=/usr/local/bin:/usr/bin:/bin" : target === "reply" ? replyText :"Question 1: why does my cron job not find node?";
      await turn.hover();
      await copy.click();
      await expect.poll(() => page.evaluate(() => window.copyProbe.read())).toBe(expected);
      if (target === "code") await expect(copy).toHaveText("Copied");
      else await expect(copy).toHaveAttribute("data-tip", "Copied");
      });
  });
}

test.describe("code blocks", () => {
  // no image engine answers here
  test.use({ comfyUrl: "http://127.0.0.1:9" });

  // Guards the owner's ask: a code block has its own working Copy.
  test("a code block's own copy button puts the exact code on the clipboard", async ({ page, open, seededThread }) => {
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    const reply = page.locator(".turn.a").last();
    // one button per fenced block; inline code spans get none
    await expect(reply.locator(".md li code").filter({ hasText: "PATH" })).toBeVisible();
    await expect(reply.getByTestId("chat.markdown.copy-code")).toHaveCount(1);
    const block = reply.locator(".md .cb");
    await expect(block.locator(".cb-lang")).toHaveText("sh");
    const copy = block.getByTestId("chat.markdown.copy-code");
    await expect(copy).toHaveCSS("opacity", "0");
    await block.hover();
    await expect(copy).toHaveCSS("opacity", "1");
    await copy.click();
    await expect(copy).toHaveText("Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("PATH=/usr/local/bin:/usr/bin:/bin");
    // "Copied" for about 1.5 s, then the plain icon again
    await expect(copy).toHaveText("", { timeout: 3000 });
    // the reply's own hover row is unchanged: copy, regenerate, meta
    await reply.locator(".md p").first().hover();
    await expect(reply.locator(".a-act [data-copy]")).toBeVisible();
    await expect(reply.locator(".a-act [data-regen]")).toBeVisible();
  });
});

test.describe("a sent message's actions", () => {
  // Guards the owner's ruling (N06): a sent message's time, Edit and Copy sit under the bubble, and showing them moves nothing.
  test("sit under the bubble at its right edge, time then Edit then Copy, and showing them moves nothing", async ({ page, open, seededThread }) => {
    await open(`#thread=${seededThread ?? ""}`); await waitReady(page);
    const turn = page.locator(".turn.u").first();
    const bubble = turn.locator(".bubble"), act = turn.locator(".u-act");
    const reply = turn.locator("xpath=following-sibling::*[1]");
    await expect(reply).toHaveClass(/\bturn a\b/);
    await page.mouse.move(700, 5);
    const off = await reply.boundingBox();
    await bubble.hover();
    await expect(act).toHaveCSS("opacity", "1");
    expect(await reply.boundingBox(), "showing the row moves nothing").toEqual(off);
    const [b, a] = await Promise.all([bubble.boundingBox(), act.boundingBox()]);
    expect(a!.y, "under the bubble").toBeGreaterThanOrEqual(b!.y + b!.height - 0.5);
    const [tm, edit, copy] = await Promise.all([act.locator(".tm").boundingBox(), act.getByTestId("chat.user-message.edit").boundingBox(), act.getByTestId("chat.copy.user-message").boundingBox()]);
    expect(tm!.x < edit!.x && edit!.x < copy!.x, "time, then Edit, then Copy").toBe(true);
  });
});
