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

// Guards the owner's ruling (N04): picker rows open no tooltip; their facts stay on the face.
test("a model row and a context row open no tooltip; a row still names its model, size and fit for screen readers", async ({ page, open }) => {
  await open(); await waitReady(page);
  const picker = await openPicker(page);
  const row = picker.locator('.pk-r[data-m="gemma4:12b"]');
  await row.locator(".pk-n").hover();
  await page.waitForTimeout(700);
  await expect(page.locator("#tip.open"), "no tooltip on a model row").toHaveCount(0);
  await expect(picker.locator(".pk-r[data-tip], .pk-ctx-row[data-tip]")).toHaveCount(0);
  const select = row.locator(".pk-select");
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

// Guards the owner's ruling (N07): the context header does not repeat the model name the list shows.
test("the wide picker's context header says only Context length; the size group still names its model", async ({ page, open }) => {
  await open(); await waitReady(page);
  const picker = await openPicker(page);
  await picker.locator('.pk-r[data-m="gemma4:12b"] .pk-n').hover();
  const head = picker.locator(".pk-context-head");
  await expect(head.locator("small"), "the model list beside it already names the model").toHaveCount(0);
  await expect(head).toHaveText("Context length");
  await expect(picker.getByRole("radiogroup")).toHaveAccessibleName("Context length for Gemma 4 12B");
});

test.describe("a sent message's actions", () => {
  test.use({ seed: 2 });

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

test.describe("the reply-running line", () => {
  test.use({ seed: 2 });
  // Guards the owner's ruling (N05): no "Reply running" line, and the composer does not move as a reply starts and ends.
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
  // Guards the owner's ruling (N11): a stopped reply gets a stop square and its seconds, no line of words, and its text holds still.
  test("is marked by a stop square and its seconds in its actions row, with no line of words, and its text holds still", async ({ page, open }) => {
    await open(); await waitReady(page);
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

    await expect(page.getByText(OLD_WORDS)).toHaveCount(0);
    await expect(page.locator(".stop-note")).toHaveCount(0);
    const mark = reply.getByRole("img", { name: UNSEEN, exact: true });
    await expect(mark).toBeVisible();
    await expect(mark).toHaveAttribute("data-tip", UNSEEN);
    await expect(reply.locator(".a-act.stop .stop-mark .s")).toHaveText(/^\d+ s$/);

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
    expect(await box(), "a reload leaves it where it was").toEqual(saved);
  });
});
