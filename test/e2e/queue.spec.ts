// Queueing and interrupting a reply, against the fake Ollama. Enter while a
// reply runs never stops it: the message waits in a tray above the composer,
// where it can be edited, removed or sent now.
import { type Page } from "@playwright/test";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

const rows = (page: Page) => page.locator(".qt-r");
const stop = (page: Page) => page.getByRole("button", { name: "Stop" });

/** A reply that keeps streaming until it is stopped. */
async function answering(page: Page): Promise<void> {
  await stack.scenario("slow-drip", { holdAfterTokens: 46 });
  await sendMessage(page, "How do I check disk space before a download?");
  await expect(page.locator(".turn.a .md ul li")).toHaveCount(3, { timeout: 15_000 });
}

// Guards the owner's ask (R19): Enter while a reply runs queues the message.
test("Enter while a reply runs queues the message and leaves the reply running; it sends itself when the reply ends", async ({ page, open }) => {
  await stack.scenario("slow-drip", { tokenDelayMs: 60, firstTokenDelayMs: 0 });
  await open();
  await waitReady(page);
  await sendMessage(page, "How do I check disk space before a download?");
  await expect(stop(page)).toBeVisible();

  await sendMessage(page, "And on a second drive?");
  await expect(rows(page)).toHaveCount(1);
  // waiting in the queue says it waits: the row holds the message, and Send now says what it stops
  await expect(rows(page).first()).toHaveText("And on a second drive?");
  await expect(rows(page).first()).toHaveAttribute("aria-label", "Queued message 1 of 1");
  await expect(rows(page).first().locator("[data-send-now]")).toHaveAttribute("data-tip", "Send now. Stops the reply");
  await expect(page.locator("#ta")).toHaveValue("");
  await expect(page.locator(".turn.u")).toHaveCount(1);
  await expect(stop(page), "the reply is still running").toBeVisible();

  await expect(rows(page)).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(".turn.u").last()).toContainText("And on a second drive?");
  await expect(page.locator(".turn.u")).toHaveCount(2);
});

// Guards the owner's ask (R19): a queued message can be edited, removed or sent now.
test("a queued message can be edited in the composer, removed, or sent now in place of the running reply", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await answering(page);

  await sendMessage(page, "First thought");
  await sendMessage(page, "Second thought");
  await expect(rows(page)).toHaveCount(2);

  // edit: the text comes back to the composer, the row keeps its place
  await rows(page).first().locator("[data-edit-queued]").click();
  await expect(page.locator("#ta")).toHaveValue("First thought");
  await expect(rows(page).first()).toContainText("Editing");
  await expect(page.locator(".composer button.send")).toHaveCount(1);
  await expect(page.locator(".composer button.send")).toHaveAccessibleName("Update queued message");
  await page.locator("#ta").fill("First thought, reworded");
  await page.locator("#ta").press("Enter");
  await expect(page.locator("#ta")).toHaveValue("");
  await expect(rows(page).first()).toContainText("First thought, reworded");
  await expect(rows(page)).toHaveCount(2);

  // remove
  await rows(page).nth(1).locator("[data-unqueue]").click();
  await expect(rows(page)).toHaveCount(1);
  await expect(page.locator(".turn.a .md ul li").first(), "removing leaves the reply alone").toBeVisible();
  await expect(stop(page)).toBeVisible();

  // send now: the running reply stops, keeping its words, and the message goes
  await rows(page).first().locator("[data-send-now]").click();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.locator(".turn.u").last()).toContainText("First thought, reworded");
  await expect(page.locator(".turn.u")).toHaveCount(2);
  await expect(page.locator(".turn.a.interrupted .md ul li")).toHaveCount(3);
  await expect(page.locator(".turn.a.interrupted .a-act.stop .s")).toHaveText(/^\d+ s$/);
  await expect(page.locator(".stop-note")).toHaveCount(0);
});

// Guards the owner's rule that Stop never sends or retries anything by itself (unsure: his words were about retry).
test("Stop leaves a queued message on hold instead of sending it", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await answering(page);

  await sendMessage(page, "Held back");
  await expect(rows(page)).toHaveCount(1);
  await stop(page).click();
  await expect(stop(page)).toHaveCount(0);

  await expect(rows(page).first()).toContainText("On hold");
  await expect(rows(page).first().locator("[data-send-now]"), "nothing is running to stop").toHaveAttribute("data-tip", "Send now");
  await expect(page.locator(".turn.u")).toHaveCount(1);
  await expect(page.locator(".turn.a.interrupted .md ul li")).toHaveCount(3);

  await rows(page).first().locator("[data-send-now]").click();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.locator(".turn.u").last()).toContainText("Held back");
});
