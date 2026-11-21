/// <reference lib="dom" />
// Active replies remain visible in the sidebar, even while a second chat owns
// its own stream.
import type { Page } from "@playwright/test";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

test.use({ seed: "design" });

const FIRST = "Library: Effect Schema books";
const SECOND = "Fix the backup cron";
const row = (page: Page, title: string) => page.locator(".sb-row").filter({ hasText: title });
const mark = (page: Page, title: string) => row(page, title).getByLabel("Reply in progress", { exact: true });
// why: with a mouse a hovered row shows its menu where the mark is, so the pointer leaves the row after the click
const select = async (page: Page, title: string) => {
  await row(page, title).locator(".sb-thread").click();
  await page.locator("#ta").hover();
};
const stop = (page: Page) => page.getByRole("button", { name: "Stop", exact: true }).click();

// Guards the owner's ask for parallel threads: a running reply stays marked in the sidebar (unsure: no explicit line on the mark).
test("a reply stays marked after navigating away and after starting a second reply", async ({ page, open, seededThread }) => {
  await stack.scenario("slow-drip", { holdAfterTokens: 12 });
  await open(`#thread=${seededThread ?? ""}`);
  await waitReady(page);
  await sendMessage(page, "Keep the first chat answering");
  await expect(mark(page, FIRST)).toBeVisible();
  await page.waitForFunction(() => ((window as unknown as { glPerf?: { deltas: number } }).glPerf?.deltas ?? 0) > 0);
  await select(page, SECOND);
  await expect(page.locator(".hdr h2")).toHaveText(SECOND);
  await expect(mark(page, FIRST)).toBeVisible();

  // Navigation alone leaves the original live slot intact; another reply parks it.
  await sendMessage(page, "Keep the second chat answering too");
  await expect(mark(page, SECOND)).toBeVisible();
  await expect(mark(page, FIRST)).toBeVisible();
  // with a mouse the row menu takes the mark's place while the row is hovered, never drawn over
  // it, and the mark is back once the pointer leaves
  await row(page, FIRST).hover();
  await expect(mark(page, FIRST)).toBeHidden();
  await page.locator("#ta").hover();
  await expect(mark(page, FIRST)).toBeVisible();

  await select(page, FIRST);
  await stop(page);
  await expect(mark(page, FIRST)).toHaveCount(0);
  await expect(mark(page, SECOND)).toBeVisible();
  await select(page, SECOND);
  await stop(page);
  await expect(mark(page, SECOND)).toHaveCount(0);
});
