/// <reference lib="dom" />
// Everything a reply did before its answer folds into one chip: bulb and
// thinking seconds, wrench and the number of calls. Closed, nothing is added
// under it while the reply runs; the part at work is lit and the current step is
// said beside it. Open (only when asked), it is one list in the order things
// happened, and an opened call shows all of its output in a box up to 360 px.
// Live checks hold each model round inside its thinking (holdThinkingAfterTokens)
// so every step is looked at while the reply is still running.
import { writeFile } from "node:fs/promises";
import { createClient } from "@gates-local/contracts";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";
import { LONG_COMMAND } from "./seed.ts";
import { release } from "./threads-support.ts";

test.use({ screenshot: "only-on-failure" });

/** A Library file and tools on, so the fake model is offered a tool to call (its read of ~/docs fails, as a real one outside the Library would). */
async function libraryOn(page: Page, info: TestInfo): Promise<void> {
  const server = new URL(page.url()).searchParams.get("server");
  if (!server) throw new Error("No test server");
  const client = createClient(new WebSocket(server));
  const file = info.outputPath("notes.md");
  await writeFile(file, "# Notes\n\nNothing to see.\n");
  await client.call("sources.add", { kind: "file", path: file });
  await client.call("settings.update", { tools: true });
}

/** Release held rounds until the chip has counted `n` calls; a release that finds nothing held is harmless. */
async function untilCalls(chip: Locator, n: number): Promise<void> {
  const name = new RegExp(`\\b${n} tool calls?\\b`);
  await expect.poll(async () => {
    if (name.test((await chip.getAttribute("aria-label")) ?? "")) return true;
    await release();
    return false;
  }, { timeout: 20_000, intervals: [50] }).toBe(true);
}

/** Where a control sits in its reply and how big it is, whatever the view's scroll. */
const placeIn = (el: Locator) => el.evaluate((n) => {
  const b = n.getBoundingClientRect();
  const t = n.closest(".turn")!.getBoundingClientRect();
  return { x: Math.round(b.left - t.left), y: Math.round(b.top - t.top), width: Math.round(b.width), height: Math.round(b.height) };
});
/** A shot for the report and the box of the thing it is about, so the report can outline it. */
async function shoot(page: Page, name: string, about: Locator): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), animations: "disabled" });
  await writeFile(test.info().outputPath(`${name}.json`), JSON.stringify({ about: await about.boundingBox() }));
}

/** Only where a box starts: a line whose words change keeps its place, not its width. */
const at = (n: { x: number; y: number }) => ({ x: n.x, y: n.y });
const heightOf = (el: Locator) => el.evaluate((n) => Math.round(n.getBoundingClientRect().height));
const topOf = (el: Locator) => el.evaluate((n) => Math.round(n.getBoundingClientRect().top));
/** Resolves once a fold has finished opening: its height the same on two frames running. */
const openedFully = (body: Locator) => body.evaluate((n) => new Promise<void>((done) => {
  let last = -1;
  const look = () => {
    const h = n.getBoundingClientRect().height;
    if (h > 0 && h === last) done();
    else { last = h; requestAnimationFrame(look); }
  };
  requestAnimationFrame(look);
}));

test.describe("live", () => {
  // Guards the owner's ruling (N14): tool calls fold into one chip that holds its box while the reply runs.
  test("ten tool calls leave the reply the same height while closed, and the chip keeps its box from running to done", async ({ page, open }, info) => {
    await open(); await waitReady(page);
    await libraryOn(page, info);
    await stack.scenario("slow-drip", { toolCalls: 10, quietToolRounds: 1, tokenDelayMs: 1, firstTokenDelayMs: 0, holdThinkingAfterTokens: 4 });
    await sendMessage(page, "Use a tool to check my notes");
    const reply = page.locator(".turn.a").last();
    const chip = reply.locator("button.think");
    // the first round is held inside its thinking: the thought line, its bulb in the box the lit mark takes
    await expect(chip).toHaveClass(/\blive\b/);
    const bulb = await placeIn(chip.locator(".th-i"));
    await untilCalls(chip, 1);
    await expect(chip).toHaveClass(/\bfold\b/);
    // chat row 37: one live line, the lit mark where the bulb was, what it does now and the time in the line itself
    expect(at(await placeIn(chip.locator(".lv-dot"))), "the lit mark sits where the bulb was").toEqual(at(bulb));
    await expect(chip.locator(".lv-w")).toBeVisible();
    await expect(chip.locator(".lv-t")).toHaveText(/^ · \d+ s$/);
    await shoot(page, "row37-live-line", chip);
    const start = at(await placeIn(chip));
    const height = await heightOf(reply);
    for (let n = 2; n <= 10; n++) {
      await untilCalls(chip, n);
      expect(at(await placeIn(chip)), `the line's place at ${n} calls`).toEqual(start);
      expect(await heightOf(reply), `the reply's height at ${n} calls`).toBe(height);
      await expect(chip).toHaveAttribute("aria-expanded", "false");
      await expect(reply.locator("[data-tool-row]").first()).toBeHidden();
    }
    await expect.poll(async () => { await release(); return reply.evaluate((n) => n.classList.contains("done")); }, { timeout: 20_000, intervals: [50] }).toBe(true);
    // done: the same place, the time and the step count, still closed; failed calls counted in red, no sentence
    expect(at(await placeIn(chip)), "the line's place once done").toEqual(start);
    await expect(chip.locator(".lv-dot")).toHaveCount(0);
    await expect(chip.locator(".lv-n")).toHaveText("10 steps");
    await expect(chip).toHaveAttribute("aria-expanded", "false");
    await expect(chip).toHaveAccessibleName(/^Thinking \d+ seconds?, 10 tool calls, \d+ failed$/);
    await expect(chip.locator(".lv-bad")).toHaveCount(1);
    await expect(reply).not.toContainText("Tool could not finish");
    await shoot(page, "row37-done-line", chip);
    await chip.click();
    await expect(reply.locator("[data-tool-row]").first()).toBeVisible();
    // a failed step's mark is red: the same colour as the count of failed on the line
    const red = await chip.locator(".lv-bad").evaluate((n) => getComputedStyle(n).color);
    await expect(reply.locator('[data-tool-row] .wr-st[data-st="rej"]').first()).toHaveCSS("color", red);
    await shoot(page, "row37-done-open", reply.getByRole("list", { name: "Steps" }));
  });

  test.describe("opened while calls run", () => {
    test.use({ seed: "work-fold", viewport: { width: 1200, height: 700 } });
    // Guards the owner's ruling (N14, chat row 18): a chip opened while calls run grows below and never jumps what is above.
    test("lines append, a finished round closes to one line, the page follows the end and never jumps what is above", async ({ page, open, seededThread }, info) => {
      await open(`#thread=${seededThread ?? ""}`); await waitReady(page);
      await libraryOn(page, info);
      await stack.scenario("slow-drip", { toolCalls: 3, quietToolRounds: 1, tokenDelayMs: 1, firstTokenDelayMs: 0, holdThinkingAfterTokens: 4 });
      await sendMessage(page, "Use a tool to check my notes");
      const reply = page.locator(".turn.a").last();
      const chip = reply.locator("button.think");
      await untilCalls(chip, 1);
      // the reply still running at the end of the thread, the page following it:
      // opening the chip moves nothing, though the list it opens grows the page
      const tl = page.locator(".tl");
      expect(await tl.evaluate((n) => n.scrollHeight - n.scrollTop - n.clientHeight), "the page is at the end").toBeLessThan(120);
      const before = await topOf(chip);
      await chip.click();
      await expect(chip).toHaveAttribute("aria-expanded", "true");
      await page.waitForTimeout(300);
      expect(await topOf(chip), "opening the chip at the end moves nothing").toBe(before);
      const list = reply.getByRole("list", { name: "Steps" });
      const items = list.locator(":scope > li");
      // round 2 is held inside its thinking: round 1 is one closed line, the call one line, round 2 open and growing
      await expect(items).toHaveCount(3);
      await expect(items.nth(0).locator(".th-line")).toHaveAttribute("aria-expanded", "false");
      await expect(items.nth(0).locator(".th-line")).toHaveText(/^\d+ s$/);
      await expect(items.nth(1).locator("[data-tool-row]")).toBeVisible();
      await expect(items.nth(2).locator(".th-line")).toHaveText("Thinking");
      await expect(items.nth(2).locator(".think-body")).toBeVisible();
      await expect(items.nth(2).locator(".think-body")).toContainText("The question is short");

      // the next call appends below; the round before it closes to one line
      await untilCalls(chip, 2);
      await expect(items).toHaveCount(5);
      await expect(items.nth(2).locator(".th-line")).toHaveAttribute("aria-expanded", "false");
      await expect(items.nth(2).locator(".th-line")).toHaveText(/^\d+ s$/);

      // at the end, the page follows: the newest line is on screen
      await tl.evaluate((n) => { n.scrollTop = n.scrollHeight; });
      await page.waitForTimeout(100);
      await untilCalls(chip, 3);
      await expect(items).toHaveCount(7);
      await page.waitForTimeout(300);
      const last = await items.last().evaluate((n) => n.getBoundingClientRect().bottom);
      const view = await tl.evaluate((n) => n.getBoundingClientRect().bottom);
      expect(last, "the newest line is on screen").toBeLessThanOrEqual(view);

      // the choice holds after the reply is done
      await expect.poll(async () => { await release(); return reply.evaluate((n) => n.classList.contains("done")); }, { timeout: 20_000, intervals: [50] }).toBe(true);
      await expect(chip).toHaveAttribute("aria-expanded", "true");
      await expect(list).toBeVisible();
      await expect(items).toHaveCount(7);
    });
  });
});

test.describe("saved", () => {
  test.use({ seed: "work-fold" });

  // Guards the owner's ruling (N15): an opened call shows all of its output in a box up to 360 px, without moving.
  test("an opened call shows all of it: a long output scrolls in a box up to 360 px, a short one has no scrollbar, the command is whole", async ({ page, open, seededThread }) => {
    await open(`#thread=${seededThread ?? ""}`); await waitReady(page);
    const reply = page.locator(".turn.a").nth(1);
    await reply.locator("button.think.fold").click();
    // read where the call sits once the fold has finished opening, not partway through its ease
    await openedFully(reply.locator(".fold-body").first());
    const rows = reply.locator("[data-tool-row]");
    const longRow = rows.nth(0);
    const line = longRow.locator(".wr-line");
    const above = await topOf(line);
    await line.click();
    await page.waitForTimeout(450);
    expect(await topOf(line), "opening a call never moves it").toBe(above);
    const box = longRow.locator(".wr-body");
    const size = await box.evaluate((n) => ({ h: n.getBoundingClientRect().height, sh: n.scrollHeight, ch: n.clientHeight, sw: n.scrollWidth, cw: n.clientWidth }));
    expect(size.h).toBeLessThanOrEqual(360);
    expect(size.sh).toBeGreaterThan(size.ch);
    expect(size.sw, "no sideways scroll").toBeLessThanOrEqual(size.cw);
    // the whole output is there, through its last line
    await expect(box).toContainText("300 Track 300");
    // the command, not the call's JSON, whole and wrapped
    const cmd = box.locator(".cmd");
    await expect(cmd).toHaveText(`$ ${LONG_COMMAND}`);
    await expect(cmd).not.toContainText('"input"');
    expect(await cmd.evaluate((n) => n.getBoundingClientRect().height), "the command wraps").toBeGreaterThan(30);
    // the keys scroll it to its last line
    await box.focus();
    await page.keyboard.press("End");
    await expect.poll(() => box.evaluate((n) => Math.ceil(n.scrollTop + n.clientHeight) >= n.scrollHeight)).toBe(true);
    const lastLine = await box.evaluate((n) => {
      const out = n.querySelector(".out")!;
      const r = document.createRange();
      r.setStart(out.firstChild!, out.textContent!.lastIndexOf("300 Track 300"));
      r.setEnd(out.firstChild!, out.textContent!.length);
      const b = r.getBoundingClientRect(), v = n.getBoundingClientRect();
      return b.top >= v.top - 1 && b.bottom <= v.bottom + 1;
    });
    expect(lastLine, "the last line is in the box once scrolled").toBe(true);
    // a three-line output: no scrollbar, no empty space
    const shortRow = rows.nth(1);
    await shortRow.locator(".wr-line").click();
    const short = await shortRow.locator(".wr-body").evaluate((n) => ({ sh: n.scrollHeight, ch: n.clientHeight }));
    expect(short.sh).toBeLessThanOrEqual(short.ch);
    expect(short.ch).toBeLessThan(120);
  });
});
