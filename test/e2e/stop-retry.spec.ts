// Journey: Stop a reply mid-stream, reload, the words are still there, and
// writing it again does not ask the question twice.
import { expect, sendMessage, test, waitReady, stack } from "./fixtures.ts";

const UNSEEN = "Stopped. The model won't see this reply.";

// Guards the owner's rule that Stop keeps the partial reply and never retries by itself.
test("a stopped reply survives a reload and Regenerate replaces it without a second question", async ({ page, open }) => {
  await open();
  await waitReady(page);
  // slow tokens so there is time to press Stop mid-reply
  await stack.scenario("models", { tokenDelayMs: 120 });
  await sendMessage(page, "Tell me about cron");

  const live = page.locator(".turn.a").last();
  await expect(live.locator(".writing")).toBeVisible();
  await expect(live.locator(".md")).not.toBeEmpty();
  await page.getByRole("button", { name: "Stop" }).click();

  // the stop square and its seconds in the reply's actions row; no line of words
  await expect(live.locator(".a-act.stop .s")).toHaveText(/^\d+ s$/);
  await expect(live.getByRole("img", { name: UNSEEN, exact: true })).toBeVisible();
  await expect(page.locator(".stop-note")).toHaveCount(0);
  await expect(page.locator(".writing")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  await expect(page.locator(".turn.a")).toHaveCount(1);
  const stopped = (await live.locator(".md").innerText()).trim();
  expect(stopped).not.toBe("");

  await page.reload();
  await waitReady(page);
  const kept = page.locator(".turn.a.interrupted");
  await expect(kept).toHaveCount(1);
  await expect(kept.locator(".md")).toContainText(stopped);
  // after a reload who stopped it and when are not known here: the square alone
  await expect(kept.getByRole("img", { name: UNSEEN, exact: true })).toBeVisible();
  await expect(kept.locator(".stop-mark .s")).toHaveCount(0);
  await expect(page.locator(".stop-note")).toHaveCount(0);

  await stack.scenario("models");
  await kept.hover();
  await kept.locator("[data-regen]").click();
  const again = page.locator(".turn.a").last();
  // the fake's full reply is 60 words and ends here
  await expect(again.locator(".md")).toContainText("so streaming takes a", { timeout: 10_000 });
  await expect(page.locator(".writing")).toHaveCount(0);
  await expect(page.locator(".turn.u")).toHaveCount(1);
  await expect(page.locator(".turn.a")).toHaveCount(1);
  await expect(page.locator(".turn.a.interrupted")).toHaveCount(0);
  await expect(page.locator(".stop-note")).toHaveCount(0);

  // a reply that breaks after some words: one note, right away, with the real reason
  await stack.scenario("mid-stream-error");
  await sendMessage(page, "And at boot?");
  await expect(page.locator(".turn.a.interrupted .md")).not.toBeEmpty();
  await expect(page.locator(".stop-note")).toHaveCount(1);
  await expect(page.locator(".stop-note")).toHaveText(/^The reply didn't finish\. .*unexpected EOF/);
  await expect(page.locator(".stop-note")).not.toContainText("excluded from later model prompts");
  await expect(page.locator(".stop-note").getByRole("img", { name: UNSEEN, exact: true })).toBeVisible();
});
