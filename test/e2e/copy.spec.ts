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
  test(`copy each content type when the clipboard API is ${mode}`, async ({ page, open, seededThread }, info) => {
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
      await page.screenshot({ path: info.outputPath("copy-feedback.png") });
      await expect.poll(() => page.evaluate(() => window.copyProbe.read())).toBe(expected);
      if (target === "code") await expect(copy).toHaveText("Copied");
      else await expect(copy).toHaveAttribute("data-tip", "Copied");
      });
  });
}

test("copy waits for success instead of flashing a premature check mark", async ({ page, open, seededThread }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => new Promise(() => undefined) } });
  });
  await open(`#thread=${seededThread ?? ""}`);
  await waitReady(page);
  for (const selector of [".turn.u [data-copy]", ".turn.a [data-copy]", ".cb-copy"]) {
    const copy = page.locator(selector).last();
    await copy.click();
    expect(await copy.getAttribute("data-tip")).not.toBe("Copied");
    expect(await copy.textContent()).not.toBe("Copied");
  }
});

for (const fallback of ["false", "throw"] as const) {
  test(`a ${fallback} fallback reports failure on messages, code and model names`, async ({ page, open, seededThread }) => {
    await limitClipboard(page, "rejected");
    await page.addInitScript((result) => {
      document.execCommand = () => {
        if (result === "throw") throw new Error("Copy unavailable");
        return false;
      };
    }, fallback);
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    for (const selector of [".turn.u [data-copy]", ".turn.a [data-copy]", ".cb-copy"]) {
      const copy = page.locator(selector).last();
      await copy.click();
      const feedback = selector === ".cb-copy" ? copy : copy.locator("..");
      await expect(feedback.getByRole("status").filter({ hasText: "Couldn't copy" })).toBeVisible();
      await expect(copy).not.toHaveAttribute("data-tip", "Copied");
      await expect(copy).not.toHaveText("Copied");
    }
    await page.keyboard.press("Control+Comma");
    await page.locator(".snav").getByRole("button", { name: "Models", exact: true }).click();
    await page.locator(".mp-kebab").first().click();
    await page.getByRole("menuitem", { name: /Copy Ollama name/ }).click();
    await expect(page.getByRole("menuitem", { name: /Couldn't copy/ })).toBeVisible();
  });
}

test("fallback restores a draft's focus and backward selection", async ({ page, open, seededThread }) => {
  await limitClipboard(page, "missing");
  await open(`#thread=${seededThread ?? ""}`);
  await waitReady(page);
  await expect(page.locator(".turn.a [data-copy]")).toHaveCount(1);
  await page.evaluate(() => window.copyProbe.write("clipboard sentinel"));
  await page.locator("#ta").fill("Keep this draft and selection");
  await page.locator("#ta").evaluate((ta: HTMLTextAreaElement) => {
    ta.focus();
    ta.setSelectionRange(5, 15, "backward");
    const copy = document.querySelector<HTMLButtonElement>(".turn.a [data-copy]");
    if (!copy) throw new Error("Reply copy control has not loaded");
    copy.click();
  });
  await expect.poll(() => page.evaluate(() => window.copyProbe.read())).toBe(reply);
  expect(await page.locator("#ta").evaluate((ta: HTMLTextAreaElement) => [document.activeElement === ta, ta.value, ta.selectionStart, ta.selectionEnd, ta.selectionDirection])).toEqual([true, "Keep this draft and selection", 5, 15, "backward"]);
  await expect(page.locator("body > textarea")).toHaveCount(0);
});

test("fallback restores a backward selection in the reply", async ({ page, open, seededThread }) => {
  await limitClipboard(page, "missing");
  await open(`#thread=${seededThread ?? ""}`);
  await waitReady(page);
  await page.evaluate(() => window.copyProbe.write("clipboard sentinel"));
  const selected = await page.locator(".turn.a .md p").first().evaluate((p) => {
    const text = p.firstChild;
    if (!text) throw new Error("Missing reply text");
    document.getSelection()?.setBaseAndExtent(text, 12, text, 2);
    const textBefore = document.getSelection()?.toString();
    document.querySelector<HTMLButtonElement>(".cb-copy")?.click();
    return textBefore;
  });
  await expect.poll(() => page.evaluate(() => window.copyProbe.read())).toBe("PATH=/usr/local/bin:/usr/bin:/bin");
  expect(await page.evaluate(() => {
    const s = document.getSelection();
    return [s?.toString(), s?.anchorOffset, s?.focusOffset];
  })).toEqual([selected, 12, 2]);
});
