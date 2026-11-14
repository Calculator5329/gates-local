/// <reference lib="dom" />
// With a page open in the panel beside the chat, the composer row fits the width the panel
// leaves: the model name gives way first and Send stays inside the composer. A fresh install
// at the default 1200 by 800 window once had Send hanging half off the composer onto the panel
// (a screen with no hover, so the touch-sized row with the Thinking label).
import type { Page } from "@playwright/test";
import { LOAN_PROMPTS } from "../fake-ollama/page-replies.ts";
import { expect, test, waitReady } from "./fixtures.ts";
import { INSTALLED, configure, start } from "./threads-support.ts";

test.use({ installed: INSTALLED });

const box = async (page: Page, selector: string) => {
  const b = await page.locator(selector).first().boundingBox();
  if (b === null) throw new Error(`${selector} has no box`);
  return b;
};

for (const input of ["mouse", "touch"] as const) {
  test.describe(input, () => {
    if (input === "touch") test.use({ isMobile: true, hasTouch: true });

    test(`with the page panel open, Send stays inside the composer at 1200 by 800 and at the narrowest window that keeps the panel beside the chat (${input})`, async ({ page, open }) => {
      await page.setViewportSize({ width: 1200, height: 800 });
      await open(); await waitReady(page);
      await configure();
      // with no page open the row has room: touch shows the word Thinking at rest (a new chat's composer is not in .cw)
      if (input === "touch") await expect(page.locator(".composer .pill.thinking .plbl")).toBeVisible();
      const word = page.locator(".cw .pill.thinking .plbl");
      await start(page, LOAN_PROMPTS[0], "qwen3.5:9b");
      await expect(page.locator(".turn.a.done")).toHaveCount(1, { timeout: 20_000 });
      await expect(page.getByTestId("pages.panel")).toBeVisible();
      test.info().annotations.push({ type: "hover", description: (await page.evaluate(() => matchMedia("(hover: none)").matches)) ? "none" : "hover" });
      // 1100 is the narrowest window with the panel beside the chat (pages.css); below it the panel covers the window
      for (const width of [1200, 1100]) {
        await page.setViewportSize({ width, height: 800 });
        await expect(page.getByTestId("pages.panel")).toBeVisible();
        const composer = await box(page, ".cw .composer");
        const send = await box(page, '.cw [data-testid="chat.composer.send"]');
        const model = await box(page, ".cw #modelBtn");
        const outlined = page.locator('.cw .composer, .cw [data-testid="chat.composer.send"]');
        for (const h of await outlined.elementHandles()) await h.evaluate((el) => { (el as HTMLElement).style.outline = "2px solid #ff4d4d"; });
        await page.screenshot({ path: test.info().outputPath(`composer-panel-${input}-${width}x800.png`) });
        for (const h of await outlined.elementHandles()) await h.evaluate((el) => { (el as HTMLElement).style.outline = ""; });
        test.info().annotations.push({ type: `${width}x800`, description: `composer ${Math.round(composer.x)}..${Math.round(composer.x + composer.width)}, send ${Math.round(send.x)}..${Math.round(send.x + send.width)}, model ${Math.round(model.x)}..${Math.round(model.x + model.width)}` });
        expect.soft(send.x, `Send starts inside the composer at ${width}x800`).toBeGreaterThanOrEqual(composer.x);
        expect.soft(send.x + send.width, `Send ends inside the composer at ${width}x800`).toBeLessThanOrEqual(composer.x + composer.width);
        // the model name gives way: its button ends before Send starts
        expect.soft(model.x + model.width, `the model button ends before Send at ${width}x800`).toBeLessThanOrEqual(send.x);
        // the word Thinking gives way before the name does: a cut name never sits beside the word
        const name = await page.locator(".cw #modelBtn .picker-trigger-name").evaluate((el) => ({ shown: el.clientWidth, whole: el.scrollWidth }));
        const said = await word.isVisible();
        test.info().annotations.push({ type: `${width}x800 name`, description: `name ${name.shown} of ${name.whole} px, Thinking word ${said ? "shown" : "icon only"}` });
        expect.soft(name.shown, `the model name keeps some room at ${width}x800`).toBeGreaterThan(0);
        if (name.shown < name.whole) expect.soft(said, `the name is cut at ${width}x800 while the word Thinking still shows`).toBe(false);
      }
    });
  });
}
