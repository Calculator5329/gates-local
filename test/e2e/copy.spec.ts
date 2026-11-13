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

const reply = [
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
      const copy = target === "code" ? turn.getByRole("button", { name: "Copy code", exact: true }) : turn.locator("[data-copy]");
      const expected = target === "code" ? "PATH=/usr/local/bin:/usr/bin:/bin" : target === "reply" ? reply : "Question 1: why does my cron job not find node?";
      await turn.hover();
      await copy.click();
      await expect.poll(() => page.evaluate(() => window.copyProbe.read())).toBe(expected);
      if (target === "code") await expect(copy).toHaveText("Copied");
      else await expect(copy).toHaveAttribute("data-tip", "Copied");
      });
  });
}
