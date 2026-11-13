/// <reference lib="dom" />
// Trims the owner asked for: the model picker's rows open no hover tooltip
// (their facts stay on the face and in the accessible text), the wide picker's
// context header drops the model name the list beside it already shows, the
// "Reply running" line above the composer is gone without moving the composer,
// a sent message's time, Edit and Copy sit under it instead of beside it, and a
// stopped reply is marked by a stop square and its seconds instead of a sentence.
import type { Page } from "@playwright/test";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

test.use({ video: "off" });

async function openPicker(page: Page) {
  await page.locator("#modelBtn").click();
  const picker = page.locator("#picker");
  await expect(picker).toBeVisible();
  await expect(picker.locator(".pk-v").filter({ hasText: "Checking" })).toHaveCount(0);
  return picker;
}

test("a model row and a context row open no tooltip; a row still names its model, size and fit for screen readers", async ({ page, open }) => {
  await open(); await waitReady(page);
  const picker = await openPicker(page);
  const row = picker.locator('.pk-r[data-m="gemma4:12b"]');
  await row.locator(".pk-n").hover();
  await page.waitForTimeout(700);
  await expect(page.locator("#tip.open"), "no tooltip on a model row").toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("trim-picker-hover.png") });
  await expect(picker.locator(".pk-r[data-tip], .pk-ctx-row[data-tip]")).toHaveCount(0);
  // What the row announces, recorded for the report.
  const select = row.locator(".pk-select");
  const said = { option: await row.evaluate(el => el.getAttribute("aria-label")), name: await select.getAttribute("aria-label") };
  await test.info().attach("row-announces", { body: JSON.stringify({ ...said, snapshot: await row.ariaSnapshot() }), contentType: "application/json" });
  await expect(select).toHaveAccessibleName("Gemma 4 12B");
  await expect(select).toHaveAccessibleDescription(/^\d+\.\d\sGB (estimated|measured); .+$/);
  // The context rows say their size and fit on their face; no tooltip repeats it.
  // (The context column follows the hovered row; a click would choose it and close the picker.)
  const ctx = picker.locator(".pk-ctx-row").first();
  await expect(ctx).toBeVisible();
  await ctx.hover();
  await page.waitForTimeout(700);
  await expect(page.locator("#tip.open"), "no tooltip on a context row").toHaveCount(0);
  // Kept: an icon-only family button still names itself.
  await picker.locator(".pk-fam").first().hover();
  await expect(page.locator("#tip.open")).toBeVisible();
});

const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true };

test("the wide picker's context header says only Context length; the size group still names its model", async ({ page, open }) => {
  await open(); await waitReady(page);
  const picker = await openPicker(page);
  await picker.locator('.pk-r[data-m="gemma4:12b"] .pk-n').hover();
  const head = picker.locator(".pk-context-head");
  await expect(head.locator("small"), "the model list beside it already names the model").toHaveCount(0);
  await expect(head).toHaveText("Context length");
  await expect(picker.getByRole("radiogroup")).toHaveAccessibleName("Context length for Gemma 4 12B");
  await page.screenshot({ path: test.info().outputPath("trim-picker-context-head.png") });
});

test.describe("the phone picker's context screen", () => {
  test.use(PHONE);
  test("keeps the model's name in its header, since the model list is not on screen", async ({ page, open }) => {
    await open(); await waitReady(page);
    const picker = await openPicker(page);
    await picker.locator('.pk-r[data-m="gemma4:12b"] .pk-select').click();
    await expect(picker.locator(".pk-context-head small")).toHaveText("Gemma 4 12B");
    await expect(picker.getByRole("radiogroup")).toHaveAccessibleName("Context length for Gemma 4 12B");
  });
});

type NameRoom = { m: string; name: string; short: number; slack: number };

/** Every row of every maker's list (Show more opened): how far its name is cut off, and the
 *  room the size column holds beyond its own words. */
async function nameRoom(page: Page): Promise<NameRoom[]> {
  const picker = page.locator("#picker");
  const fams = picker.locator(".pk-fam");
  const seen = new Map<string, NameRoom>();
  for (let i = 0; i < await fams.count(); i++) {
    await fams.nth(i).click();
    const more = picker.locator(".pk-more").filter({ hasText: "Show more" });
    if (await more.count() > 0 && await more.isEnabled()) await more.click();
    const rows = await picker.locator(".pk-r").evaluateAll((els) => els.map((row) => {
      const nm = row.querySelector<HTMLElement>(".pk-nm"), v = row.querySelector<HTMLElement>(".pk-v");
      if (!nm || !v) return null;
      const words = document.createRange();
      words.selectNodeContents(v);
      return { m: row.getAttribute("data-m") ?? "", name: nm.textContent ?? "", short: nm.scrollWidth - nm.clientWidth, slack: Math.floor(v.clientWidth - words.getBoundingClientRect().width) };
    }));
    for (const r of rows) if (r) seen.set(r.m, r);
  }
  return [...seen.values()];
}

for (const scenario of ["models", "long-name"] as const) {
  test.describe(`model names (${scenario} fixture)`, () => {
    test.use({ scenario });
    test("a cut-off name gets the size column's spare room before it is cut", async ({ page, open }) => {
      await open(); await waitReady(page);
      await openPicker(page);
      const rows = await nameRoom(page);
      const cut = rows.filter((r) => r.short > 0);
      const fixable = cut.filter((r) => r.short <= r.slack);
      console.log(`NAME_ROOM ${scenario} ${JSON.stringify({ rows: rows.length, cut: cut.length, fixable: fixable.length, cutNames: cut.map((r) => `${r.name} (${r.short} px short, ${r.slack} px spare)`) })}`);
      expect(rows.length).toBeGreaterThan(0);
      expect(fixable.map((r) => r.name), "names cut off while the size column has room to spare").toEqual([]);
    });
  });
}

test.describe("a sent message's actions", () => {
  test.use({ seed: 2 });

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
    expect(Math.abs(a!.x + a!.width - (b!.x + b!.width)), "right edge on the bubble's right edge").toBeLessThanOrEqual(1);
    const [tm, edit, copy] = await Promise.all([act.locator(".tm").boundingBox(), act.getByRole("button", { name: "Edit", exact: true }).boundingBox(), act.getByRole("button", { name: "Copy", exact: true }).boundingBox()]);
    expect(tm!.x < edit!.x && edit!.x < copy!.x, "time, then Edit, then Copy").toBe(true);
    const gap = off!.y - (b!.y + b!.height);
    const replyRow = await reply.locator(".a-act").boundingBox();
    console.log(`USER_ACT ${JSON.stringify({ bubbleToReply: gap, rowHeight: a!.height, userRowToReplyRow: replyRow ? replyRow.y - (a!.y + a!.height) : null })}`);
    expect(gap, "the gap to the reply grows by at most 12 px over the 44 px turn gap").toBeLessThanOrEqual(56);
    await page.screenshot({ path: test.info().outputPath("trim-useract-hover.png") });
  });

  test("a message that fills the column keeps the row under it, right edges aligned", async ({ page, open, seededThread }) => {
    await open(`#thread=${seededThread ?? ""}`); await waitReady(page);
    const done = page.locator(".turn.a.done");
    const replies = await done.count();
    const long = "A long message that fills the whole column so its actions have no room beside it. ".repeat(6).trim();
    await page.locator("#ta").fill(long);
    await page.locator("#ta").press("Enter");
    await expect(done).toHaveCount(replies + 1);
    // the saved turn replaces the pending one; hover retries until it holds still
    const turn = page.locator(".col > .turn.u").last();
    const bubble = turn.locator(".bubble"), act = turn.locator(".u-act");
    await expect(bubble).toContainText("A long message that fills");
    await bubble.hover();
    await expect(act).toHaveCSS("opacity", "1");
    const [b, a, col] = await Promise.all([bubble.boundingBox(), act.boundingBox(), page.locator(".col").boundingBox()]);
    expect(b!.width, "the bubble fills its 85% of the column").toBeGreaterThan(col!.width * 0.8);
    expect(a!.y).toBeGreaterThanOrEqual(b!.y + b!.height - 0.5);
    expect(Math.abs(a!.x + a!.width - (b!.x + b!.width))).toBeLessThanOrEqual(1);
    await page.screenshot({ path: test.info().outputPath("trim-useract-long.png") });
  });
});

test.describe("a sent message's actions on a phone", () => {
  test.use({ seed: 2, ...PHONE });
  test("a tap shows them under the bubble without moving the reply", async ({ page, open, seededThread }) => {
    await open(`#thread=${seededThread ?? ""}`); await waitReady(page);
    const turn = page.locator(".turn.u").first();
    const reply = turn.locator("xpath=following-sibling::*[1]");
    const off = await reply.boundingBox();
    await turn.locator(".bubble").tap();
    const edit = turn.getByRole("button", { name: "Edit", exact: true });
    await expect(edit).toBeVisible();
    expect(await reply.boundingBox(), "showing the row moves nothing").toEqual(off);
    const [b, e] = await Promise.all([turn.locator(".bubble").boundingBox(), edit.boundingBox()]);
    expect(e!.y).toBeGreaterThanOrEqual(b!.y + b!.height - 0.5);
    expect(e!.height, "touch targets stay 44 px").toBeGreaterThanOrEqual(44);
  });
});

test.describe("the reply-running line", () => {
  test.use({ seed: 2 });
  test("is gone; the composer does not move as a reply starts and ends, and Stop stays one click away while editing", async ({ page, open, seededThread }) => {
    await open(`#thread=${seededThread ?? ""}`); await waitReady(page);
    const top = () => page.locator(".composer").evaluate(el => el.getBoundingClientRect().top);
    const before = await top();
    await stack.scenario("slow-drip", { holdAfterTokens: 46 });
    await page.locator("#ta").fill("Keep this reply running");
    const primary = page.locator(".composer button.send");
    await primary.click();
    await expect(primary).toHaveAccessibleName("Stop");
    await expect(page.locator(".turn.a").last().locator(".md ul li")).toHaveCount(3);
    expect(await top(), "a reply starting leaves the composer where it was").toBe(before);
    await expect(page.getByText("Reply running", { exact: true })).toHaveCount(0);
    await expect(page.locator("[data-running-status]")).toHaveCount(0);
    await expect(page.locator(".composer .stop-sq"), "the main button is Stop").toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("trim-reply-running.png") });
    // A desktop draft keeps Stop as the main button (Enter queues); editing a queued message is where Stop moves aside, into Dictate's square.
    await page.locator("#ta").fill("Keep this queued draft");
    await page.locator("#ta").press("Enter");
    const v = await page.locator(".composer .voice").boundingBox();
    await page.locator(".qt-r [data-edit-queued]").click();
    await expect(primary).toHaveAccessibleName("Update queued message");
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    await expect(stop).toBeVisible();
    await expect(stop).toHaveAttribute("data-tip", "Stop this reply. Your draft stays here");
    expect(await stop.boundingBox(), "Dictate's square").toEqual(v);
    await expect(page.locator(".composer .voice"), "Dictate gives its square to Stop while the edit lasts").toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("trim-reply-running-draft.png") });
    await stop.click();
    await expect(primary).toHaveAccessibleName("Update queued message");
    await expect(page.locator("#ta")).toHaveValue("Keep this queued draft");
    await expect(stop).toHaveCount(0);
    expect(await top(), "the reply ending leaves the composer where it was").toBe(before);
  });
});

test.describe("a reply the person stopped", () => {
  const UNSEEN = "Stopped. The model won't see this reply.";
  const OLD_WORDS = /excluded from later model prompts|Its text is kept here|Stopped after|Interrupted before this reply finished/;
  test("is marked by a stop square and its seconds in its actions row, with no line of words, and its text holds still", async ({ page, open }) => {
    await open(); await waitReady(page);
    // a finished reply first: the mark matches the size and colour of its facts
    await sendMessage(page, "Say something short");
    await expect(page.locator(".turn.a.done")).toHaveCount(1);
    await stack.scenario("models", { tokenDelayMs: 120 });
    await sendMessage(page, "Tell me about cron");
    const reply = page.locator(".turn.a").last();
    await expect(reply.locator(".writing")).toBeVisible();
    await expect.poll(async () => (await reply.locator(".md").innerText()).split(/\s+/).length).toBeGreaterThan(8);
    // where the reply's last block sits in the column, before Stop, right after, once saved, after a reload
    const blocks = reply.locator(".md > *");
    const k = await blocks.count();
    const box = () => page.locator(".turn.a").last().locator(".md > *").nth(k - 1).evaluate(el => {
      const r = el.getBoundingClientRect(), c = el.closest(".col")!.getBoundingClientRect();
      return { top: r.top - c.top, left: r.left - c.left, height: r.height };
    });
    const before = await box();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(reply.locator(".writing")).toHaveCount(0);
    const stopped = await box();
    await expect(page.locator(".turn.a.interrupted")).toHaveCount(1);
    await expect(reply.locator(".a-act")).toHaveCount(1);
    const saved = await box();

    // the pictures first, so the run on the old build still takes its "before"
    await page.mouse.move(1, 1);
    await reply.locator(".a-act").evaluate(el => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(300);
    const notes = await page.locator(".stop-note").count();
    if (notes > 0) await page.locator(".stop-note").evaluate(el => { el.style.outline = "2px solid #f5a524"; el.style.outlineOffset = "2px"; });
    const md = (await reply.locator(".md").boundingBox())!;
    const act = (await reply.locator(".a-act").boundingBox())!;
    const clip = { x: Math.max(0, md.x - 24), y: Math.max(0, act.y - 112), width: md.width + 48, height: 184 };
    await page.screenshot({ path: test.info().outputPath(notes > 0 ? "trim-stopped-before.png" : "trim-stopped-after.png"), clip });
    console.log("STOPPED_BOX", JSON.stringify({ blocks: k, before, stopped, saved, notes }));

    await expect(page.getByText(OLD_WORDS)).toHaveCount(0);
    await expect(page.locator(".stop-note")).toHaveCount(0);
    const mark = reply.getByRole("img", { name: UNSEEN, exact: true });
    await expect(mark).toBeVisible();
    await expect(mark).toHaveAttribute("data-tip", UNSEEN);
    const secs = reply.locator(".a-act.stop .stop-mark .s");
    await expect(secs).toHaveText(/^\d+ s$/);
    // at rest only the square shows; the seconds and the actions show on hover, like a finished reply's facts
    const opacity = (sel: string) => reply.locator(sel).first().evaluate(el => getComputedStyle(el).opacity);
    expect(await opacity(".a-act.stop")).toBe("1");
    expect(await opacity(".a-act.stop .s")).toBe("0");
    expect(await opacity(".a-act.stop [data-copy]")).toBe("0");
    const style = (sel: string) => page.locator(sel).first().evaluate(el => { const s = getComputedStyle(el); return { size: s.fontSize, color: s.color }; });
    expect(await style(".turn.a.interrupted .a-act .stop-mark .s"), "the finished reply's facts' size and colour").toEqual(await style(".turn.a.done .a-act .meta"));
    const [m, copy] = await Promise.all([mark.boundingBox(), reply.locator("[data-copy]").boundingBox()]);
    expect(Math.abs(m!.x + m!.width / 2 - 4 - md.x), "the square starts at the text's left edge").toBeLessThanOrEqual(1);
    expect(m!.y + m!.height / 2, "on the actions row").toBeCloseTo(copy!.y + copy!.height / 2, 0);
    expect(copy!.x, "the actions follow the mark").toBeGreaterThan(m!.x + m!.width);
    await reply.hover();
    await page.waitForTimeout(300);
    expect(await opacity(".a-act.stop .s")).toBe("1");
    expect(await opacity(".a-act.stop [data-copy]")).toBe("1");
    await mark.hover();
    await expect(page.locator("#tip.open")).toHaveText(UNSEEN);
    await page.screenshot({ path: test.info().outputPath("trim-stopped-hover.png"), clip });

    // the reply's text holds still from Stop through the save
    expect(stopped.top, "Stop leaves the last block where it was").toBeCloseTo(before.top, 1);
    expect(saved, "saving leaves it where it was").toEqual(stopped);

    // after a reload this client no longer knows who stopped it or when: the square alone, the same text in the same place
    await page.reload(); await waitReady(page);
    const kept = page.locator(".turn.a.interrupted");
    await expect(kept).toHaveCount(1);
    await expect(kept.getByRole("img", { name: UNSEEN, exact: true })).toBeVisible();
    await expect(kept.locator(".stop-mark .s")).toHaveCount(0);
    await expect(page.locator(".stop-note")).toHaveCount(0);
    await expect(page.getByText(OLD_WORDS)).toHaveCount(0);
    const reloaded = await box();
    console.log("STOPPED_BOX reloaded", JSON.stringify(reloaded));
    expect(reloaded, "a reload leaves it where it was").toEqual(saved);
  });
});
