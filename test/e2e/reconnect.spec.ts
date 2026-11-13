// Journey: the server restarts under an open thread. The banner says it is
// reconnecting, the thread survives, and chat works once it is back.
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

// the browser logs each refused WebSocket attempt while the server is down
test.use({ allowedErrors: [/WebSocket connection to .* failed/] });

// Guards the owner's ask that the app reconnects after a server restart and keeps the thread.
test("after a server restart the app reconnects, keeps the thread and chats again", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await sendMessage(page, "First question");
  await expect(page.locator(".turn.a .md").last()).toContainText("You asked: First question", { timeout: 10_000 });
  await expect(page.locator(".writing")).toHaveCount(0);
  const url = page.url();

  const restart = stack.restart(2000);
  await expect(page.getByText("Reconnecting to Gates Local")).toBeVisible();
  await expect(page.locator("#ta")).toHaveAttribute("placeholder", "Chat starts when Gates Local reconnects…");
  await restart;

  await waitReady(page);
  await expect(page.getByText("Reconnecting to Gates Local")).toHaveCount(0);
  expect(page.url()).toBe(url);
  await expect(page.locator(".turn.u")).toHaveCount(1);
  await expect(page.locator(".sb-row.on")).toContainText("First question");

  await sendMessage(page, "Second question");
  await expect(page.locator(".turn.a .md").last()).toContainText("You asked: Second question", { timeout: 10_000 });
  await expect(page.locator(".turn.u")).toHaveCount(2);
});
