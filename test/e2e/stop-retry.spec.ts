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
  await expect(live.locator(".think.run")).toBeVisible();
  await expect(live.locator(".md")).not.toBeEmpty();
  await page.getByRole("button", { name: "Stop" }).click();

  // the stop square and its seconds in the reply's actions row; no line of words
  await expect(live.locator(".a-act.stop .s")).toHaveText(/^\d+ s$/);
  const secs = (await live.locator(".stop-mark .s").innerText()).trim();
  await expect(live.getByRole("img", { name: UNSEEN, exact: true })).toBeVisible();
  await expect(page.locator(".stop-note")).toHaveCount(0);
  await expect(page.locator(".think.run")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  await expect(page.locator(".turn.a")).toHaveCount(1);
  const stopped = (await live.locator(".md").innerText()).trim();
  expect(stopped).not.toBe("");

  await page.reload();
  await waitReady(page);
  const kept = page.locator(".turn.a.interrupted");
  await expect(kept).toHaveCount(1);
  await expect(kept.locator(".md")).toContainText(stopped);
  // after a reload the square keeps Stop's seconds: the server saved them with the row (chat row 32)
  await expect(kept.getByRole("img", { name: UNSEEN, exact: true })).toBeVisible();
  await expect(kept.locator(".stop-mark .s")).toHaveText(secs);
  await expect(page.locator(".stop-note")).toHaveCount(0);

  await stack.scenario("models");
  await kept.hover();
  await kept.locator("[data-regen]").click();
  const again = page.locator(".turn.a").last();
  // the fake's full reply is 60 words and ends here
  await expect(again.locator(".md")).toContainText("so streaming takes a", { timeout: 10_000 });
  await expect(page.locator(".think.run")).toHaveCount(0);
  await expect(page.locator(".turn.u")).toHaveCount(1);
  await expect(page.locator(".turn.a")).toHaveCount(1);
  await expect(page.locator(".turn.a.interrupted")).toHaveCount(0);
  await expect(page.locator(".stop-note")).toHaveCount(0);

  // a reply that breaks after some words, and again on the server's one more try: one line with the
  // alert, the short words and Retry, the runtime's own words in its tip, never the stop square (decision 7)
  await stack.scenario("mid-stream-error");
  await sendMessage(page, "And at boot?");
  const failed = page.getByTestId("chat.reply.failed");
  await expect(failed).toHaveCount(1, { timeout: 15_000 });
  await expect(failed).toHaveText(/^The reply didn't finish\.\s*Retry$/);
  await expect(failed).toHaveAttribute("data-tip", /unexpected EOF/);
  await expect(page.getByTestId("chat.reply.retry")).toBeVisible();
  await expect(page.locator(".turn.a").last().getByRole("img", { name: UNSEEN, exact: true })).toHaveCount(0);
  await expect(page.locator(".stop-note")).toHaveCount(0);
});
