/// <reference lib="dom" />
// A reply's thought while the model is still thinking. The "Thinking" pill is
// the same control as the finished "Thought for N s" line: it opens only when
// asked, its text grows in place as it arrives, and the choice the person made
// holds through the reply. The fake holds a turn inside its thinking
// (holdThinkingAfterTokens) so each check looks at a thought still arriving.
import { FAKE_URL } from "./env.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";
import { holds, settled } from "./waits.ts";

test.use({ screenshot: "only-on-failure" });

/** Every held turn goes on: one held in its thinking thinks on, one held in its reply writes on. */
async function release(): Promise<void> {
  const r = await fetch(`${FAKE_URL}/__fake/release`, { method: "POST", body: "{}" });
  expect(r.ok).toBe(true);
}

const FINISHED = /^Thought for \d+ s$/;

// Guards the owner's ruling: a live thought opens only when asked and grows in place without replaying its ease.
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
  await holds(page, 400, async () => [await pill.getAttribute("aria-expanded"), await body.isVisible()], ["false", false], { message: "the thought stays shut" });

  await pill.click();
  await expect(pill).toHaveAttribute("aria-expanded", "true");
  await expect(body).toBeVisible();
  await expect(body).toContainText("The question is short");
  await expect(body).not.toContainText("without a tool");
  // the open ease (180 ms) is over; from here arriving text only adds words
  await settled(page, body);
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
  // thinking is over and the reply has started: still open; the line says "Writing" until the
  // reply ends (reply-ended.spec.ts), and the same stable name
  await expect(pill).toHaveAttribute("aria-expanded", "true");
  await expect(pill).toContainText("Writing");
  await expect(pill).toHaveAccessibleName("Writing");
  await release();
  await expect(reply).toHaveClass(/\bdone\b/, { timeout: 15_000 });
  // the finished line's words hide at rest, so its name carries them
  await expect(pill).toHaveAttribute("aria-label", FINISHED);
  await expect(pill).toHaveAttribute("aria-expanded", "true");
  await expect(body).toBeVisible();
});

test.describe("a finished thought", () => {
  // no image engine answers here
  test.use({ comfyUrl: "http://127.0.0.1:9" });

  // Guards the finished thinking row: at rest the bulb and a chevron, its seconds in words on hover
  // and on keyboard focus without moving the reply, and a click opens it.
  test("a finished thinking row rests as its icon and says its seconds on hover and focus", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await sendMessage(page, "Tell me about cron");
    const reply = page.locator(".turn.a").last();
    await expect(reply).toHaveClass(/\bdone\b/, { timeout: 15_000 });
    const think = reply.locator("button.think");
    const label = think.getByText(/^Thought for \d+ s$/);
    await expect(think.locator(".lv-i")).toBeVisible();
    await expect(think.locator(".th-x")).toBeVisible();
    await expect(label).toHaveCount(1);
    await expect(label).toBeHidden();
    // the words are hidden at rest, so the button's name carries them
    await expect(think).toHaveAttribute("aria-label", /^Thought for \d+ s$/);
    const before = await reply.locator(".md").boundingBox();

    await think.hover();
    await expect(label).toBeVisible();
    expect(await reply.locator(".md").boundingBox()).toEqual(before);

    await page.mouse.move(5, 5);
    await expect(label).toBeHidden();
    await page.keyboard.press("Tab");
    await think.focus();
    await expect(label).toBeVisible();
    expect(await reply.locator(".md").boundingBox()).toEqual(before);

    // click opens the reasoning, and it stays open after the pointer leaves
    await think.click();
    await page.mouse.move(5, 5);
    await expect(think).toHaveAttribute("aria-expanded", "true");
    await expect(reply.locator(".think-body")).toBeVisible();
    await expect(reply.locator(".think-body")).toContainText("Answer it plainly");
  });
});
