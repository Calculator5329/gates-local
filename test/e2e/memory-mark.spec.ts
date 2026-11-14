// Settings row 28, the owner 2026-11-13 (proposal 05, he picked A): "the measure for a model is not
// what is available now its based on the ram in the card". One memory mark, the same wherever a
// model's memory shows: a bar that is the whole card, a fill for what this model takes, and the
// number ("6.6 / 16 GB"). What other programs hold is said once under the list, never per row.
import type { Locator, Page } from "@playwright/test";
import { expect, openModels, stack, test, waitReady } from "./fixtures.ts";

const BLENDER_MIB = Math.round(9.7 * 1024);
/** One decimal under 10 GB, whole from 10 up, as the picture reads ("6.6 / 16 GB", "17 / 16 GB"). */
const MARK = /^(\d\.\d|\d{2,}) \/ (\d+) GB$/;

/** The mark's number, and its fill as a share of its bar. */
async function readMark(mark: Locator) {
  const text = (await mark.locator(".mm-n").textContent()) ?? "";
  const [, need, whole] = MARK.exec(text) ?? [];
  const fill = await mark.evaluate((el) => {
    const bar = el.querySelector(".mm-bar")?.getBoundingClientRect().width ?? 0;
    const f = el.querySelector(".mm-bar i")?.getBoundingClientRect().width ?? 0;
    return bar > 0 ? f / bar : -1;
  });
  return { text, need: Number(need), whole: Number(whole), fill };
}

async function expectMarks(rows: Locator, whole: number) {
  const all = await rows.all();
  expect(all.length, "rows to check").toBeGreaterThan(0);
  for (const row of all) {
    const m = await readMark(row.locator(".mm:visible"));
    expect(m.text,`${await row.getAttribute("data-dm") ?? await row.getAttribute("data-cat")}: "need / card GB"`).toMatch(MARK);
    expect(m.whole, "the bar is the whole card").toBe(whole);
    // the fill is the need over the card, whole when it needs more than the card has
    expect(m.fill).toBeCloseTo(Math.min(1, m.need / whole), 1);
  }
}

/** The line about other programs is said once, and under the list. */
async function saidOnceUnder(page: Page, line: Locator, list: Locator) {
  await expect(line).toHaveText("blender is using 9.7 GB of GPU memory right now.", { timeout: 15_000 });
  await expect(page.getByText(/blender/)).toHaveCount(1);
  const [l, b] = [await line.boundingBox(), await list.boundingBox()];
  expect(l && b && l.y >= b.y + b.height - 1, "the line sits under the list").toBe(true);
}

test("one memory mark in Models and Download, against the card, with other programs said once under the list", async ({ page, open }, info) => {
  await stack.scenario("models", { installed: ["qwen3.5:9b", "gemma4:12b"] });
  await open();
  await waitReady(page);
  await openModels(page);
  const installed = page.locator(".mp-card .mp-row[data-dm]");
  await expect(installed.first().locator(".mm:visible")).toHaveCount(1);
  // another program takes GPU memory once the app has seen the card at rest (fit-card.spec.ts)
  await stack.gpu(BLENDER_MIB);
  await expectMarks(installed, 16);
  await saidOnceUnder(page, page.locator(".mp-others"), page.locator(".mp-card"));
  await page.screenshot({ path: info.outputPath("mark-models.png"), animations: "disabled" });

  await page.getByRole("tab", { name: /^Download/ }).click();
  const list = page.locator(".mp");
  await expect(list.locator("[aria-busy=true]")).toHaveCount(0);
  await expectMarks(list.locator(".dlrow[data-cat]"), 16);
  await saidOnceUnder(page, list.locator(".dl-others"), list.locator(".grp:not(.dl-bigs) .dlrow[data-cat]").last());
  await page.screenshot({ path: info.outputPath("mark-download.png"), animations: "disabled" });
});

// The computer keeps some of its memory for itself, so a model can be too big while needing less than the whole.
test("with no GPU the mark is the computer's memory, and a model too big for it is a full grey bar", async ({ page, open }, info) => {
  await stack.scenario("models", { installed: ["qwen3.5:9b", "gemma4:12b"] });
  await stack.computer(15.6, "none");
  await open();
  await waitReady(page);
  await openModels(page);
  await page.getByRole("tab", { name: /^Download/ }).click();
  const big = page.locator("details.dl-bigs");
  await big.locator("summary").click();
  for (const row of await big.locator(".dlrow[data-cat]").all()) {
    const mark = row.locator(".mm");
    const m = await readMark(mark);
    expect(m.text).toMatch(MARK);
    expect(m.whole, "the computer's own memory").toBe(16);
    expect(m.need).toBeGreaterThan(12);
    await expect(mark).toHaveClass(/\bno\b/);
    await expect(mark).toHaveAttribute("aria-label", /^Too big for this computer: /);
    expect(m.fill, "a model too big for the computer fills the bar").toBeCloseTo(1, 2);
  }
  await page.screenshot({ path: info.outputPath("mark-nogpu-big.png"), animations: "disabled" });
});
