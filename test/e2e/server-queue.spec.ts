// The queue is the server's: every window shows the same queued messages, a
// change in one shows in the others, and a reload keeps what was waiting
// without putting it on hold.
import { type Page } from "@playwright/test";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

const rows = (page: Page) => page.locator(".qt-r");
const stop = (page: Page) => page.getByRole("button", { name: "Stop" });
const shot = (page: Page, name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`) });

// Guards the owner's ask: a second window sees the queue and can change it.
test("a message queued in one window shows in a second window, and removing it there removes it everywhere", async ({ page, open, context }) => {
  await open();
  await waitReady(page);
  await stack.scenario("slow-drip", { holdAfterTokens: 46 });
  await sendMessage(page, "How do I check disk space before a download?");
  await expect(page.locator(".turn.a .md ul li")).toHaveCount(3, { timeout: 15_000 });
  await sendMessage(page, "Queued in the first window");
  await expect(rows(page)).toHaveCount(1);

  const other = await context.newPage();
  await other.goto(page.url());
  await waitReady(other);
  await expect(rows(other), "the second window shows the server's queue").toHaveCount(1);
  await expect(rows(other).first()).toHaveText("Queued in the first window");
  await expect(rows(other).first(), "waiting, not on hold").not.toContainText("On hold");
  await shot(other, "second-window-sees-queue");

  await rows(other).first().locator("[data-unqueue]").click();
  await expect(rows(other)).toHaveCount(0);
  await expect(rows(page), "removed in the second window, gone in the first").toHaveCount(0);
  await shot(page, "first-window-after-remove");

  // the removed message never goes: the reply ends and nothing follows it
  await stop(page).click();
  await expect(stop(page)).toHaveCount(0);
  await expect(page.locator(".turn.u")).toHaveCount(1);
  await expect(other.locator(".turn.u")).toHaveCount(1);
  await other.close();
});

// Guards the owner's ask: a queued message survives a reload and still sends itself.
test("a reload while a message is queued keeps it waiting, and it sends itself when the reply ends", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await stack.scenario("slow-drip", { tokenDelayMs: 150, firstTokenDelayMs: 0 });
  await sendMessage(page, "How do I check disk space before a download?");
  await expect(stop(page)).toBeVisible();
  await sendMessage(page, "Queued before the reload");
  await expect(rows(page)).toHaveCount(1);

  await page.reload();
  await waitReady(page);
  await expect(rows(page), "the reload keeps it").toHaveCount(1);
  await expect(rows(page).first()).toHaveText("Queued before the reload");
  await expect(rows(page).first(), "still waiting for the reply, not on hold").not.toContainText("On hold");
  await shot(page, "after-reload-still-queued");

  await expect(rows(page)).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator(".turn.u")).toHaveCount(2);
  await expect(page.locator(".turn.u").last()).toContainText("Queued before the reload");
  await shot(page, "after-reload-sent");
});
