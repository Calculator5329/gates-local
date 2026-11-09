// Journey: Stop a reply mid-stream, reload, the words are still there, and
// writing it again does not ask the question twice.
import { expect, sendMessage, test, waitReady, stack } from "./fixtures.ts";

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

  await expect(page.locator(".stop-note")).toHaveCount(1);
  await expect(page.locator(".stop-note")).toHaveText(/^Stopped after \d+ s\. Its text is kept here and excluded from later model prompts\.$/);
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
  await expect(page.locator(".stop-note")).toHaveCount(1);
  await expect(page.locator(".stop-note")).toHaveText(/^Interrupted before this reply finished\. Its text is kept/);

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
  await expect(page.locator(".stop-note")).toHaveText(/^The reply didn't finish\. .*unexpected EOF.* Its text is kept here and excluded from later model prompts\.$/);
});
