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
import { readOpening, sampleHeights } from "./eased.ts";
import { appUrl } from "./env.ts";
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
const heightOf = (el: Locator) => el.evaluate((n) => Math.round(n.getBoundingClientRect().height));
const topOf = (el: Locator) => el.evaluate((n) => Math.round(n.getBoundingClientRect().top));
/** How far the page is from its end. */
const gapOf = (tl: Locator) => tl.evaluate((n) => n.scrollHeight - n.scrollTop - n.clientHeight);
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
  test("ten tool calls leave the reply the same height while closed, and the chip keeps its box from running to done", async ({ page, open }, info) => {
    await open(); await waitReady(page);
    await libraryOn(page, info);
    await stack.scenario("slow-drip", { toolCalls: 10, quietToolRounds: 1, tokenDelayMs: 1, firstTokenDelayMs: 0, holdThinkingAfterTokens: 4 });
    await sendMessage(page, "Use a tool to check my notes");
    const reply = page.locator(".turn.a").last();
    const chip = reply.locator("button.think");
    // the first round is held inside its thinking: the thought line, its bulb where the chip's will be
    await expect(chip).toHaveClass(/\blive\b/);
    const bulb = await placeIn(chip.locator(".ic").first());
    await untilCalls(chip, 1);
    await expect(chip).toHaveClass(/\bfold\b/);
    expect(await placeIn(chip.locator(".ic").first()), "the bulb keeps its place and size as the line becomes the chip").toEqual(bulb);
    const box = await placeIn(chip);
    const height = await heightOf(reply);
    // the current step is said beside the chip, and the part at work is lit
    await expect(reply.locator(".fold-now")).toBeVisible();
    for (let n = 2; n <= 10; n++) {
      await untilCalls(chip, n);
      expect(await placeIn(chip), `the chip's box at ${n} calls`).toEqual(box);
      expect(await heightOf(reply), `the reply's height at ${n} calls`).toBe(height);
      await expect(chip).toHaveAttribute("aria-expanded", "false");
      await expect(reply.locator("[data-tool-row]").first()).toBeHidden();
    }
    await expect(chip.locator(".ch-n").last()).toHaveText("10");
    await expect.poll(async () => { await release(); return reply.evaluate((n) => n.classList.contains("done")); }, { timeout: 20_000, intervals: [50] }).toBe(true);
    // done: the same box, the words gone, still closed; the last call failed, so the chip says so
    expect(await placeIn(chip), "the chip's box once done").toEqual(box);
    await expect(reply.locator(".fold-now")).toHaveCount(0);
    await expect(chip).toHaveAttribute("aria-expanded", "false");
    await expect(chip).toHaveAccessibleName(/^Thinking \d+ seconds?, 10 tool calls, last call failed$/);
    await expect(chip.locator(".ch-p.bad")).toHaveCount(1);
  });

  test.describe("opened while calls run", () => {
    test.use({ seed: "work-fold", viewport: { width: 1200, height: 700 } });
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
      await expect(items.nth(0).locator(".th-line")).toHaveText(/^Thought · \d+ s$/);
      await expect(items.nth(1).locator("[data-tool-row]")).toBeVisible();
      await expect(items.nth(2).locator(".th-line")).toHaveText("Thinking");
      await expect(items.nth(2).locator(".think-body")).toBeVisible();
      await expect(items.nth(2).locator(".think-body")).toContainText("The question is short");

      // the next call appends below; the round before it closes to one line
      await untilCalls(chip, 2);
      await expect(items).toHaveCount(5);
      await expect(items.nth(2).locator(".th-line")).toHaveAttribute("aria-expanded", "false");
      await expect(items.nth(2).locator(".th-line")).toHaveText(/^Thought · \d+ s$/);

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

/**
 * The reader at the end of the work-fold thread opens its last chip alone. Its list
 * is one call, shorter than the 120 px that keeps a reader's own scroll following
 * the end: past the hold the page is a little short of its end, and only the end
 * itself follows now.
 */
async function openLastChip(page: Page): Promise<Locator> {
  const tl = page.locator(".tl");
  await tl.evaluate((n) => { n.scrollTop = n.scrollHeight; });
  await page.waitForTimeout(100);
  expect(await gapOf(tl), "at the end").toBeLessThan(2);
  const reply = page.locator(".turn.a").nth(2);
  const chip = reply.locator("button.think.fold");
  await expect(chip).toHaveAccessibleName("1 tool call, last call failed");
  // dispatched, so nothing scrolls it into view first: the reader is at the end when it opens
  await chip.dispatchEvent("click");
  await expect(chip).toHaveAttribute("aria-expanded", "true");
  await page.waitForTimeout(450);
  const gap = await gapOf(tl);
  expect(gap, "the opened list left the end").toBeGreaterThan(2);
  expect(gap, "by less than the reader's own scroll would still follow").toBeLessThan(120);
  const row = reply.locator("[data-tool-row]").first();
  await expect(row).toBeVisible();
  return row;
}

test.describe("opened at the end of a thread", () => {
  test.use({ seed: "work-fold", viewport: { width: 1200, height: 700 } });

  test("opening a chip alone at the end, then the composer growing, moves nothing", async ({ page, open, seededThread }) => {
    await open(`#thread=${seededThread ?? ""}`); await waitReady(page);
    const row = await openLastChip(page);
    const before = await topOf(row);
    const composer = page.locator(".composer");
    const short = await heightOf(composer);
    await page.locator("#ta").focus();
    for (const line of ["one", "two"]) { await page.keyboard.type(line); await page.keyboard.press("Shift+Enter"); }
    await page.keyboard.type("three");
    await expect.poll(() => heightOf(composer), { message: "three lines grow the composer" }).toBeGreaterThan(short);
    await page.waitForTimeout(300);
    expect(await topOf(row), "the opened row has not moved").toBe(before);
  });

  test("opening a chip alone at the end, then another device's question and its reply's words arriving, moves nothing", async ({ page, open, seededThread, context }) => {
    await open(`#thread=${seededThread ?? ""}`); await waitReady(page);
    const other = await context.newPage();
    await other.goto(appUrl(`#thread=${seededThread ?? ""}`)); await waitReady(other);
    const row = await openLastChip(page);
    const before = await topOf(row);
    await stack.scenario("slow-drip", { tokenDelayMs: 60, firstTokenDelayMs: 0 });
    await sendMessage(other, "Asked on the other device");
    await expect(page.locator(".turn.u").last()).toContainText("Asked on the other device");
    await expect(page.locator(".turn.a:not(.done) .md")).toContainText("Here is how to check the free disk space");
    await page.waitForTimeout(200);
    expect(await topOf(row), "the opened row has not moved").toBe(before);
    await expect(page.locator(".writing")).toHaveCount(0, { timeout: 20_000 });
    await other.close();
  });
});

test.describe("saved", () => {
  test.use({ seed: "work-fold" });

  test("closed chips: a recovered failure is not on the chip, an unrecovered one is; no tools and no thinking keep only their part", async ({ page, open, seededThread }) => {
    await open(`#thread=${seededThread ?? ""}`); await waitReady(page);
    const replies = page.locator(".turn.a");
    await expect(replies).toHaveCount(4);
    const [recovered, long, failed, thought] = [replies.nth(0), replies.nth(1), replies.nth(2), replies.nth(3)];
    // an old thread: no first-token time was kept, so the bulb has no number
    await expect(recovered.locator("button.think.fold")).toHaveAccessibleName("Thinking, 3 tool calls");
    await expect(recovered.locator(".ch-p.bad")).toHaveCount(0);
    await expect(recovered.locator("[data-tool-row]").first()).toBeHidden();
    await expect(long.locator("button.think.fold")).toHaveAccessibleName("Thinking, 2 tool calls");
    // no thinking: only the wrench part, marked, since the call before the answer failed
    await expect(failed.locator("button.think.fold")).toHaveAccessibleName("1 tool call, last call failed");
    await expect(failed.locator(".ch-p")).toHaveCount(1);
    await expect(failed.locator(".ch-p.bad")).toHaveCount(1);
    // no tools: the thought line as it was
    await expect(thought.locator("button.think")).not.toHaveClass(/\bfold\b/);
    await expect(thought.locator("button.think")).toHaveAccessibleName("Show thinking");
    await expect(thought.locator(".fold-body")).toHaveCount(0);
    for (const r of [recovered, long, failed, thought]) await expect(r.locator("button.think")).toHaveAttribute("aria-expanded", "false");
  });

  test("open: one list in order, each call said once, Enter and Space work the chip", async ({ page, open, seededThread }) => {
    await open(`#thread=${seededThread ?? ""}`); await waitReady(page);
    const reply = page.locator(".turn.a").first();
    const chip = reply.locator("button.think.fold");
    await chip.focus();
    await page.keyboard.press("Enter");
    await expect(chip).toHaveAttribute("aria-expanded", "true");
    const items = reply.getByRole("list", { name: "Steps" }).getByRole("listitem");
    await expect(items).toHaveCount(4);
    // a saved reply keeps no order between its thought and its calls: the thought first, closed
    await expect(items.nth(0).locator(".th-line")).toHaveText("Thought");
    await expect(items.nth(0).locator(".th-line")).toHaveAttribute("aria-expanded", "false");
    await expect(items.nth(1).locator(".wr-h")).toHaveText("Searched your library");
    await expect(items.nth(2).locator(".wr-h")).toHaveText("Tool could not finish");
    await expect(items.nth(2).locator(".wr-m")).toHaveText("Shell · failed");
    await expect(items.nth(3).locator(".wr-h")).toHaveText("Searched your library");
    await chip.focus();
    await page.keyboard.press(" ");
    await expect(chip).toHaveAttribute("aria-expanded", "false");
  });

  test("the opened list eases open over several frames, never in one jump", async ({ page, open, seededThread }) => {
    await open(`#thread=${seededThread ?? ""}`); await waitReady(page);
    const reply = page.locator(".turn.a").first();
    const seen = await sampleHeights(reply.locator(".fold-body"), () => reply.locator("button.think.fold").click());
    // .fold-body's height transition in styles.css: .18s ease. Judged against time, so a frame the
    // machine skipped is not a jump, and a list that opens in one normal frame still is.
    const opening = readOpening(seen, 180);
    expect(opening.full, "the list opened").toBeGreaterThan(40);
    expect(opening.closedFirst, "sampling began with the list closed").toBe(true);
    expect(opening.ahead, "no frame shows more of the list than a 180 ms ease could by then").toEqual([]);
  });

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
