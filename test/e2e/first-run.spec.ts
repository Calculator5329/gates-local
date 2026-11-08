// Journey: first launch with models installed, then a streamed reply with
// thinking collapsed into one line.
import { expect, sendMessage, test } from "./fixtures.ts";

test.use({ skipFirstRun: false });

test("first run finds Ollama and its models, then a streamed reply shows thinking", async ({ page, open }) => {
  await open();
  await expect(page.getByRole("heading", { name: "Ready to chat" })).toBeVisible();
  await expect(page.locator(".fr-st")).toContainText("Ollama 0.40.4 · 3 chat models");
  await expect(page.locator(".fr-card .nm")).toHaveText("Qwen 3.5 9B");
  await page.getByRole("button", { name: "Start chatting" }).click();

  await expect(page.getByRole("heading", { name: "What would you like help with?" })).toBeVisible();
  await expect(page.locator("#ta")).toBeFocused();
  await sendMessage(page, "What is a context window");

  // "Writing" shows while the reply streams, then the turn settles
  await expect(page.locator(".writing")).toBeVisible();
  const reply = page.locator(".turn.a").last();
  await expect(reply.locator(".md")).toContainText("You asked: What is a context window");
  await expect(page.locator(".writing")).toHaveCount(0, { timeout: 10_000 });
  await expect(page).toHaveURL(/#thread=/);

  // thinking is one collapsed line that opens on click
  const think = reply.locator("button.think");
  await expect(think).toHaveAttribute("aria-expanded", "false");
  await think.click();
  await expect(think).toHaveAttribute("aria-expanded", "true");
  await expect(reply.locator(".think-body")).toContainText("Answer it plainly");

  // the thread is in the sidebar, titled from the first message
  await expect(page.locator(".sb-row.on")).toContainText("What is a context window");
});
