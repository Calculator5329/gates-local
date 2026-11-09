// Journey: Stop a reply mid-stream, then Retry it to a full answer.
import { expect, sendMessage, test, waitReady, stack } from "./fixtures.ts";

test("Stop ends the reply where it is and Retry writes it again", async ({ page, open }) => {
  await open();
  await waitReady(page);
  // slow tokens so there is time to press Stop mid-reply
  await stack.scenario("models", { tokenDelayMs: 120 });
  await sendMessage(page, "Tell me about cron");

  const live = page.locator(".turn.a").last();
  await expect(live.locator(".writing")).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();

  await expect(live).toContainText(/Stopped after \d+ s/);
  await expect(page.locator(".writing")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();

  await stack.scenario("models");
  await live.getByRole("button", { name: "Retry" }).click();
  const again = page.locator(".turn.a").last();
  // the fake's full reply is 60 words and ends here
  await expect(again.locator(".md")).toContainText("so streaming takes a", { timeout: 10_000 });
  await expect(page.locator(".writing")).toHaveCount(0);
  await expect(page.getByText(/Stopped after/)).toHaveCount(0);
});
