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
const select = (page: Page, title: string) => row(page, title).locator(".sb-thread").click();
const stop = (page: Page) => page.getByRole("button", { name: "Stop", exact: true }).click();

const overlap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

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
  await row(page, FIRST).hover();
  const [running, actions] = [await mark(page, FIRST).boundingBox(), await row(page, FIRST).locator(".sb-menu").boundingBox()];
  expect(running).not.toBeNull();
  expect(actions).not.toBeNull();
  if (running === null || actions === null) throw new Error("running mark or row actions have no box");
  expect(overlap(running, actions), "the running mark leaves the row menu clear").toBe(false);

  await select(page, FIRST);
  await stop(page);
  await expect(mark(page, FIRST)).toHaveCount(0);
  await expect(mark(page, SECOND)).toBeVisible();
  await select(page, SECOND);
  await stop(page);
  await expect(mark(page, SECOND)).toHaveCount(0);
});
