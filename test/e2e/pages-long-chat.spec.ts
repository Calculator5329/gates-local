/// <reference lib="dom" />
// A long chat opens on its newest messages, but its page list is the whole chat's: a page made in
// a message the window has not loaded is in the panel's list, counted in its versions and opened
// from the stepper, and the chip of a later page names its place among them. Before this the list
// came from loaded messages only, so the page in message 10 of 450 was missing.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { loanPage } from "../fake-ollama/page-replies.ts";
import { CONTROL_URL } from "./env.ts";
import { expect, test, waitReady } from "./fixtures.ts";

const MESSAGES = 450;
const panel = (page: Page) => page.getByTestId("pages.panel");
const step = (page: Page) => page.getByTestId("pages.panel.step");
const framed = (page: Page) => page.frameLocator('[data-testid="pages.frame"]');

const reply = (code: string) => `Here is the page.\n\n\`\`\`html\n${code}\n\`\`\`\n`;

/** A picture with the changed parts outlined; the outlines come off after. */
async function shot(page: Page, name: string, ...changed: Locator[]): Promise<void> {
  const marked = await Promise.all(changed.map((l) => l.elementHandles())).then((hs) => hs.flat());
  for (const h of marked) await h.evaluate((el) => { (el as HTMLElement).style.outline = "2px solid #ff4d4d"; (el as HTMLElement).style.outlineOffset = "-2px"; });
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  for (const h of marked) await h.evaluate((el) => { (el as HTMLElement).style.outline = ""; (el as HTMLElement).style.outlineOffset = ""; });
}

/** A fresh stack with a 450-message thread whose 10th message (a reply) and last reply hold pages. */
async function seedPages(): Promise<string> {
  const r = await fetch(`${CONTROL_URL}/reset`, { method: "POST", body: JSON.stringify({ scenario: "models", seed: MESSAGES }) });
  if (!r.ok) throw new Error(`reset: ${r.status} ${await r.text()}`);
  const { dataDir, threadId } = (await r.json()) as { dataDir: string; threadId: string };
  const db = new DatabaseSync(path.join(dataDir, "threads.sqlite"));
  try {
    const nth = db.prepare("SELECT id FROM messages WHERE thread_id = ? ORDER BY created_at, seq LIMIT 1 OFFSET ?");
    const set = db.prepare("UPDATE messages SET content = ? WHERE id = ?");
    const tenth = nth.get(threadId, 9) as { id: string };
    const last = nth.get(threadId, MESSAGES - 1) as { id: string };
    set.run(reply(loanPage()), tenth.id);
    set.run(reply(loanPage({ slider: true })), last.id);
  } finally {
    db.close();
  }
  return threadId;
}

test("a page in message 10 of a 450-message chat is in the page list and opens from it", async ({ page, open }) => {
  test.info().annotations.push({ type: "budget", description: "a second reset seeds the 450-message thread, then two pages run in the panel" });
  const threadId = await seedPages();
  await open(`#thread=${threadId}`);
  await waitReady(page);
  // the window holds the newest messages only: the 10th is not on the page
  await expect(page.getByTestId("pages.chip")).toHaveCount(1);
  await expect(panel(page)).toBeVisible();
  await shot(page, "long-chat-page-list", step(page), page.getByTestId("pages.chip"));
  // both pages are versions, the newest on show; its chip says it is the second
  await expect(step(page)).toHaveText("2 of 2");
  await expect(page.getByTestId("pages.chip")).toContainText("v2");
  await expect(framed(page).locator("#rate")).toHaveAttribute("type", "range");
  // the older version is the page from message 10, and it runs
  await page.getByTestId("pages.panel.older").click();
  await expect(step(page)).toHaveText("1 of 2");
  await expect(framed(page).locator("#rate")).toHaveAttribute("type", "number");
  await expect(framed(page).locator("#monthly")).toHaveText("$489.15");
  await shot(page, "long-chat-older-page", step(page), page.getByTestId("pages.frame"));
});
