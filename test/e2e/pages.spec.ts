/// <reference lib="dom" />
// A page a reply writes runs in the panel beside the chat: it arrives and
// runs, a follow-up makes the next version while the panel keeps the last,
// the stepper goes back, the choice survives a reload, and a closed panel
// stays closed until a chip opens it. Save gives the page's source; a narrow
// window keeps the keys in the panel; a phone's first page waits for its chip.
// Pictures of each step go with the results.
import { appendFile, readFile } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";
import { LOAN_PROMPTS, loanPage } from "../fake-ollama/page-replies.ts";
import { expect, sendMessage, test, waitReady } from "./fixtures.ts";
import { INSTALLED, configure, release, start } from "./threads-support.ts";

test.use({ installed: INSTALLED });

const chips = (page: Page) => page.getByTestId("pages.chip");
const panel = (page: Page) => page.getByTestId("pages.panel");
const step = (page: Page) => page.getByTestId("pages.panel.step");
const framed = (page: Page) => page.frameLocator('[data-testid="pages.frame"]');
const done = (page: Page, count: number) => expect(page.locator(".turn.a.done")).toHaveCount(count, { timeout: 20_000 });

/** A measured reading, kept with the test's results. */
async function note(name: string, text: string): Promise<void> {
  test.info().annotations.push({ type: name, description: text });
  await appendFile(test.info().outputPath("notes.txt"), `${name}: ${text}\n`);
}

/** A picture with the changed parts outlined; the outlines come off after. */
async function shot(page: Page, name: string, ...changed: Locator[]): Promise<void> {
  const marked = await Promise.all(changed.map((l) => l.elementHandles())).then((hs) => hs.flat());
  for (const h of marked) await h.evaluate((el) => { (el as HTMLElement).style.outline = "2px solid #ff4d4d"; (el as HTMLElement).style.outlineOffset = "-2px"; });
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  for (const h of marked) await h.evaluate((el) => { (el as HTMLElement).style.outline = ""; (el as HTMLElement).style.outlineOffset = ""; });
}

test("a page arrives and runs, a follow-up makes v2, the stepper goes back, close and a chip reopen", async ({ page, open }) => {
  test.info().annotations.push({ type: "budget", description: "Three streamed page versions, one held part way, two reloads, a save and a narrow window walked with the keyboard." });
  await open(); await waitReady(page);
  // the slider reply stops part way into its page until released
  await configure({ prompts: { [LOAN_PROMPTS[1]]: { holdAfterTokens: 60 } } });

  await test.step("the first page opens the panel and runs", async () => {
    await start(page, LOAN_PROMPTS[0]);
    await done(page, 1);
    await expect(chips(page)).toHaveCount(1);
    await expect(chips(page).first()).toContainText("Loan calculator");
    await expect(chips(page).first()).toContainText("v1");
    await expect(chips(page).first()).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".turn.a pre")).toHaveCount(0);
    await expect(panel(page)).toBeVisible();
    await expect(page.getByTestId("pages.panel.title")).toHaveText("Loan calculator");
    await expect(step(page)).toHaveText("1 of 1");
    const monthly = framed(page).locator("#monthly");
    await expect(monthly).toHaveText("$489.15");
    await framed(page).locator("#amount").fill("30000");
    await expect(monthly).toHaveText("$586.98");
    await shot(page, "after-v1", panel(page), chips(page));
  });

  await test.step("save gives a file holding the page's own source", async () => {
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("pages.panel.save").click()]);
    expect(download.suggestedFilename()).toBe("loan-calculator.html");
    expect(await readFile(await download.path(), "utf8")).toBe(loanPage());
  });

  await test.step("while the next version is written, its chip names it with the working mark, and the panel keeps v1", async () => {
    await sendMessage(page, LOAN_PROMPTS[1]);
    const writing = page.getByTestId("pages.writing");
    await expect(writing).toBeVisible();
    // the running line says "Writing"; the chip says the page's name once its <title> has come, and no word or count
    await expect.soft(writing).toHaveText("Loan calculator");
    await expect.soft(writing.locator(".run-dot")).toHaveCount(1);
    await expect(page.locator(".turn.a").last().locator("pre")).toHaveCount(0);
    await expect(step(page)).toHaveText("1 of 1");
    await expect(framed(page).locator("#rate")).toHaveAttribute("type", "number");
    await shot(page, "r2-c", writing);
    await release(LOAN_PROMPTS[1]);
    await done(page, 2);
    await expect(writing).toHaveCount(0);
    await expect(step(page)).toHaveText("2 of 2");
    await expect(framed(page).locator("#rate")).toHaveAttribute("type", "range");
  });

  await test.step("a third version, then the stepper goes back", async () => {
    await sendMessage(page, LOAN_PROMPTS[2]);
    await done(page, 3);
    await expect(step(page)).toHaveText("3 of 3");
    await expect(framed(page).locator("#sum")).toHaveText("60 payments · $4,349 interest · $29,349 in all");
    await expect(chips(page).nth(2)).toHaveAttribute("aria-pressed", "true");
    await shot(page, "after-v3", panel(page), chips(page));
    await page.getByTestId("pages.panel.older").click();
    await expect(step(page)).toHaveText("2 of 3");
    await expect(chips(page).nth(1)).toHaveAttribute("aria-pressed", "true");
    await expect(chips(page).nth(2)).toHaveAttribute("aria-pressed", "false");
    await expect(framed(page).locator("#sum")).toHaveText("60 payments");
  });

  await test.step("the version on show survives a reload", async () => {
    await page.reload(); await waitReady(page);
    await done(page, 3);
    await expect(step(page)).toHaveText("2 of 3");
  });

  await test.step("the code view shows the page as written", async () => {
    await page.getByTestId("pages.panel.code").click();
    const source = page.getByTestId("pages.panel.source");
    await expect(source).toContainText('<input id="rate" type="range"');
    await expect(page.getByTestId("pages.frame")).toHaveCount(0);
    await shot(page, "after-code", source, page.getByTestId("pages.panel.code"));
    await page.getByTestId("pages.panel.code").click();
    await expect(page.getByTestId("pages.frame")).toBeVisible();
  });

  await test.step("closed stays closed, through a reload; a chip opens it on its version", async () => {
    await page.getByTestId("pages.panel.close").click();
    await expect(panel(page)).toHaveCount(0);
    for (const n of [0, 1, 2]) await expect(chips(page).nth(n)).toHaveAttribute("aria-pressed", "false");
    await shot(page, "after-closed", chips(page));
    await page.reload(); await waitReady(page);
    await done(page, 3);
    await expect(panel(page)).toHaveCount(0);
    await chips(page).first().click();
    await expect(panel(page)).toBeVisible();
    await expect(step(page)).toHaveText("1 of 3");
    await expect(framed(page).locator("#monthly")).toHaveText("$489.15");
  });

  await test.step("a narrow window gets the panel over the chat, with the header's title given room and the keys kept in it", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    // a window going narrow with the panel open keeps it open
    await expect(panel(page)).toBeVisible();
    // as a phone opens the chat: the drawer the wide sidebar became is shut
    await page.reload(); await waitReady(page);
    await expect(step(page)).toHaveText("1 of 3");
    await expect(framed(page).locator("#monthly")).toHaveText("$489.15");
    const box = await panel(page).boundingBox();
    expect(box).toEqual({ x: 0, y: 0, width: 390, height: 844 });
    await shot(page, "r2-a", page.locator(".pg-head"));
    // the header drops "open in its own window" so the title has room
    const widths = await page.locator(".pg-head > *").evaluateAll((els) => els.map((el) => `${el.className || el.tagName}:${Math.round(el.getBoundingClientRect().width)}`));
    const name = page.getByTestId("pages.panel.title");
    const fit = await name.evaluate((el) => ({ shown: el.clientWidth, needs: el.scrollWidth }));
    await note("narrow header", `${widths.join(" ")}; title ${fit.shown} of ${fit.needs} px`);
    await expect.soft(page.getByTestId("pages.panel.open-window")).toBeHidden();
    // the button's 44 px, the header's icon and its divider went to the title: the whole name shows
    expect.soft(fit.shown).toBeGreaterThanOrEqual(fit.needs);
    // the keyboard cannot reach the chat under the panel
    const outside: string[] = [];
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press("Tab");
      const at = await page.evaluate(() => {
        const a = document.activeElement;
        return a === null || a === document.body || a.closest(".pg-panel") !== null ? "" : a.id || a.getAttribute("data-testid") || a.tagName;
      });
      if (at !== "") outside.push(at);
    }
    expect.soft(outside).toEqual([]);
    await page.getByTestId("pages.panel.close").click();
    await expect(panel(page)).toHaveCount(0);
    await expect(page.locator("#ta")).toBeVisible();
  });
});

test("on a phone a chat's first page comes as a chip, and a tap opens it", async ({ page, open }) => {
  await open(); await waitReady(page);
  // sent from a wide window (the phone's model sheet has steps of its own), written into a phone-wide one
  await configure({ prompts: { [LOAN_PROMPTS[0]]: { holdAfterTokens: 20 } } });
  await start(page, LOAN_PROMPTS[0]);
  await page.setViewportSize({ width: 390, height: 844 });
  await release(LOAN_PROMPTS[0]);
  await done(page, 1);
  await expect(chips(page)).toHaveCount(1);
  await shot(page, "r2-b", chips(page));
  // the panel would cover the chat, so it waits for the tap
  await expect(panel(page)).toHaveCount(0);
  await expect(chips(page).first()).toHaveAttribute("aria-pressed", "false");
  await chips(page).first().click();
  await expect(panel(page)).toBeVisible();
  await expect(framed(page).locator("#monthly")).toHaveText("$489.15");
});
