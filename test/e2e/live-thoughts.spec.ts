/// <reference lib="dom" />
// A reply's thought while the model is still thinking. The "Thinking" pill is
// the same control as the finished "Thought for N s" line: it opens only when
// asked, its text grows in place as it arrives, and the choice the person made
// holds through the reply. The fake holds a turn inside its thinking
// (holdThinkingAfterTokens) so each check looks at a thought still arriving.
import { FAKE_URL } from "./env.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

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
