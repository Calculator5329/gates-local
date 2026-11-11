/// <reference lib="dom" />
// A reply's thought while the model is still thinking. The "Thinking" pill is
// the same control as the finished "Thought for N s" line: it opens only when
// asked, its text grows in place as it arrives, and the choice the person made
// holds through the reply. The fake holds a turn inside its thinking
// (holdThinkingAfterTokens) so each check looks at a thought still arriving.
import type { Locator } from "@playwright/test";
import { FAKE_URL } from "./env.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";
import { pick } from "./threads-support.ts";

test.use({ screenshot: "only-on-failure" });

/** Every held turn goes on: one held in its thinking thinks on, one held in its reply writes on. */
async function release(): Promise<void> {
  const r = await fetch(`${FAKE_URL}/__fake/release`, { method: "POST", body: "{}" });
  expect(r.ok).toBe(true);
}

/** Where the pill sits in its reply and how big it is, whatever the view's scroll. */
const placeIn = (pill: Locator) => pill.evaluate((el) => {
  const b = el.getBoundingClientRect();
  const t = el.closest(".turn")!.getBoundingClientRect();
  return { x: b.left - t.left, y: b.top - t.top, width: b.width, height: b.height };
});

const FINISHED = /^Thought for \d+ s$/;

test("while the model thinks, the Thinking pill opens on a click and its text grows in place", async ({ page, open }) => {
  await open(); await waitReady(page);
  await stack.scenario("slow-drip", { holdThinkingAfterTokens: 6, holdAfterTokens: 10 });
  await sendMessage(page, "Check disk space");
  const reply = page.locator(".turn.a").last();
  const pill = reply.locator("button.think");
  const body = reply.locator(".think-body");
  await expect(pill).toBeVisible();
  await expect(pill).toContainText("Thinking");
  // a screen reader hears one stable name, not each second or each piece of text
  await expect(pill).toHaveAccessibleName("Thinking");
  await expect(body).not.toHaveAttribute("aria-live");
  // it never opens by itself
  await page.waitForTimeout(400);
  await expect(pill).toHaveAttribute("aria-expanded", "false");
  await expect(body).toBeHidden();

  await pill.click();
  await expect(pill).toHaveAttribute("aria-expanded", "true");
  await expect(body).toBeVisible();
  await expect(body).toContainText("The question is short");
  await expect(body).not.toContainText("without a tool");
  // the open ease (180 ms) is over; from here arriving text only adds words
  await page.waitForTimeout(300);
  await body.evaluate((el) => {
    const w = window as unknown as { glNode: Node | null; glEases: string[] };
    w.glNode = el.firstChild;
    w.glEases = [];
    el.addEventListener("transitionrun", (e) => { if (e.target === el) w.glEases.push((e as TransitionEvent).propertyName); });
  });
  await release();
  await expect(body).toContainText("without a tool");
  await expect(reply.locator(".md")).toBeVisible();
  const seen = await body.evaluate((el) => {
    const w = window as unknown as { glNode: Node | null; glEases: string[] };
    return { same: el.childNodes.length === 1 && el.firstChild === w.glNode, eases: w.glEases };
  });
  expect(seen.same, "the text is updated in place, not rebuilt per piece").toBe(true);
  expect(seen.eases, "arriving text does not replay the open ease").toEqual([]);
  // thinking is over and the reply has started: still open, now the finished line
  await expect(pill).toHaveAttribute("aria-expanded", "true");
  await expect(pill.getByText(FINISHED)).toBeVisible();
  await release();
  await expect(reply).toHaveClass(/\bdone\b/, { timeout: 15_000 });
  await expect(pill).toHaveAttribute("aria-expanded", "true");
  await expect(body).toBeVisible();
});

for (const opened of [false, true]) {
  test(`a thought left ${opened ? "open" : "closed"} while thinking stays ${opened ? "open" : "closed"} through the reply, in the same box`, async ({ page, open }) => {
    await open(); await waitReady(page);
    await stack.scenario("slow-drip", { holdThinkingAfterTokens: 6, holdAfterTokens: 10 });
    await sendMessage(page, "Check disk space");
    const reply = page.locator(".turn.a").last();
    const pill = reply.locator("button.think");
    const body = reply.locator(".think-body");
    await expect(pill).toContainText("Thinking");
    if (opened) {
      // Enter and Space work the pill as a click does
      await pill.focus();
      await page.keyboard.press("Enter");
      await expect(pill).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Space");
      await expect(pill).toHaveAttribute("aria-expanded", "false");
      await page.keyboard.press("Space");
      await expect(pill).toHaveAttribute("aria-expanded", "true");
      await expect(body).toContainText("The question is short");
    }
    // long enough for the live label to count a second
    await page.waitForTimeout(1300);
    await expect(pill).toContainText("Thinking");
    const thinking = await placeIn(pill);

    await release();
    await expect(pill.getByText(FINISHED)).toBeVisible();
    expect(await placeIn(pill), "Thinking becomes Thought for in the same box").toEqual(thinking);
    await expect(pill).toHaveAttribute("aria-expanded", String(opened));

    await release();
    await expect(reply).toHaveClass(/\bdone\b/, { timeout: 15_000 });
    expect(await placeIn(pill), "and keeps it when the reply ends").toEqual(thinking);
    await expect(pill).toHaveAttribute("aria-expanded", String(opened));
    if (opened) await expect(body).toBeVisible();
    else await expect(body).toBeHidden();
  });
}

test("an open, growing thought follows the bottom as a reply does, and leaves a reader who scrolled up alone", async ({ page, open }) => {
  await page.setViewportSize({ width: 1100, height: 560 });
  await open(); await waitReady(page);
  await stack.scenario("slow-drip", { holdThinkingAfterTokens: 6, thinkingRepeat: 20, tokenDelayMs: 4, holdAfterTokens: 1 });
  const tl = page.locator(".tl");
  const gap = () => tl.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

  // at the bottom: the view follows the thought as it grows past the view
  await sendMessage(page, "first question");
  const first = page.locator(".turn.a").last();
  await first.locator("button.think").click();
  await release();
  await expect(first.locator(".md")).toBeVisible({ timeout: 15_000 });
  const firstBody = first.locator(".think-body");
  expect(await firstBody.evaluate((el) => el.getBoundingClientRect().height), "the thought is taller than the view").toBeGreaterThan(await tl.evaluate((el) => el.clientHeight));
  await expect.poll(gap).toBeLessThan(2);
  await release();
  await expect(first).toHaveClass(/\bdone\b/, { timeout: 15_000 });

  // scrolled up while reading: the thought grows and the reply starts below, and nothing in view moves
  await sendMessage(page, "second question");
  const second = page.locator(".turn.a").last();
  const pill = second.locator("button.think");
  await expect(pill).toContainText("Thinking");
  await expect.poll(gap).toBeLessThan(2);
  await pill.click();
  await expect(second.locator(".think-body")).toContainText("The question is short");
  await page.waitForTimeout(300);
  await tl.evaluate((el) => { el.scrollTop -= 200; });
  await expect.poll(gap).toBeGreaterThan(150);
  const top = await tl.evaluate((el) => el.scrollTop);
  const eye = (await pill.boundingBox())!.y;
  await release();
  await expect(second.locator(".md")).toBeAttached({ timeout: 15_000 });
  await expect(second.locator(".think-body")).toContainText("without a tool");
  expect(await tl.evaluate((el) => el.scrollTop), "the view stays where the reader left it").toBe(top);
  expect((await pill.boundingBox())!.y, "nothing above the reader's eye jumps").toBe(eye);
  await release();
});

test("Stop while thinking keeps what arrived readable, with the stopped line", async ({ page, open }) => {
  await open(); await waitReady(page);
  await stack.scenario("slow-drip", { holdThinkingAfterTokens: 6 });
  await sendMessage(page, "Check disk space");
  const reply = page.locator(".turn.a").last();
  const pill = reply.locator("button.think");
  await expect(pill).toContainText("Thinking");
  await pill.click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  // the stopped reply's note, as for a reply stopped while writing; the thought stays as the person left it
  await expect(page.locator(".stop-note")).toContainText("Stopped after");
  await expect(pill).not.toHaveClass(/\blive\b/);
  await expect(pill).not.toHaveAccessibleName("Thinking");
  await expect(pill).toHaveAttribute("aria-expanded", "true");
  await expect(reply.locator(".think-body")).toBeVisible();
  await expect(reply.locator(".think-body")).toContainText("The question is short");
});

test("a reload while the model thinks shows the thought so far, closed until asked", async ({ page, open }) => {
  await open(); await waitReady(page);
  await stack.scenario("slow-drip", { holdThinkingAfterTokens: 6 });
  await sendMessage(page, "Check disk space");
  await expect(page.locator(".turn.a button.think")).toContainText("Thinking");
  await page.reload();
  const reply = page.locator(".turn.a").last();
  const pill = reply.locator("button.think");
  await expect(pill).toContainText("Thinking");
  await expect(pill).toHaveAttribute("aria-expanded", "false");
  await pill.click();
  await expect(reply.locator(".think-body")).toContainText("The question is short");
  await release();
  await expect(reply).toHaveClass(/\bdone\b/, { timeout: 15_000 });
  await expect(reply.locator(".think-body")).toContainText("without a tool");
});

test("a model that does not think shows no thought, while writing or after", async ({ page, open }) => {
  await open(); await waitReady(page);
  await pick(page, "gemma4:12b");
  await stack.scenario("slow-drip", { holdAfterTokens: 3 });
  await sendMessage(page, "Check disk space");
  const reply = page.locator(".turn.a").last();
  await expect(reply.locator(".md")).toBeVisible();
  await expect(reply.locator(".think")).toHaveCount(0);
  await release();
  await expect(reply).toHaveClass(/\bdone\b/, { timeout: 15_000 });
  await expect(reply.locator(".think")).toHaveCount(0);
});
