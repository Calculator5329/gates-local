/// <reference lib="dom" />
// Probe after the row-menu change: active replies remain visible in the
// sidebar, even while a second chat or another client owns their stream.
import type { Page } from "@playwright/test";
import { appUrl } from "./env.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

test.use({ seed: "design", video: process.env["GL_E2E_RECORD"] || process.env["GL_FLICKER_MEASURE"] ? "on" : "off" });

const FIRST = "Library: Effect Schema books";
const SECOND = "Fix the backup cron";
const row = (page: Page, title: string) => page.locator(".sb-row").filter({ hasText: title });
const mark = (page: Page, title: string) => row(page, title).getByLabel("Reply in progress", { exact: true });
const select = (page: Page, title: string) => row(page, title).locator(".sb-thread").click();
const stop = (page: Page) => page.getByRole("button", { name: "Stop", exact: true }).click();

const overlap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function geometry(page: Page) {
  const target = row(page, FIRST);
  const boxes = {
    row: await target.boundingBox(),
    title: await target.locator(".t").boundingBox(),
    actions: await target.locator(".sb-menu").boundingBox(),
  };
  for (const box of Object.values(boxes)) expect(box).not.toBeNull();
  return boxes;
}

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
  await page.screenshot({ path: test.info().outputPath("two-running-chats.png") });

  await select(page, FIRST);
  await stop(page);
  await expect(mark(page, FIRST)).toHaveCount(0);
  await expect(mark(page, SECOND)).toBeVisible();
  await select(page, SECOND);
  await stop(page);
  await expect(mark(page, SECOND)).toHaveCount(0);
});

test("the running mark preserves row, title and menu boxes, then clears when the reply ends", async ({ page, open, seededThread }) => {
  await stack.scenario("slow-drip", { tokenDelayMs: 40, firstTokenDelayMs: 0 });
  await open(`#thread=${seededThread ?? ""}`);
  await waitReady(page);
  await row(page, FIRST).hover();
  const before = await geometry(page);
  await sendMessage(page, "Finish this reply normally");
  await expect(mark(page, FIRST)).toBeVisible();
  await row(page, FIRST).hover();
  expect(await geometry(page), "showing the mark reserves the same space").toEqual(before);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, { timeout: 20_000 });
  await expect(mark(page, FIRST)).toHaveCount(0);
  expect(await geometry(page), "removing the mark leaves the same space").toEqual(before);
});

test("a start received from another client marks its off-screen thread and its stop clears the mark", async ({ page, open, seededThread }) => {
  await stack.scenario("slow-drip", { holdAfterTokens: 12 });
  await open(`#thread=${seededThread ?? ""}`);
  await waitReady(page);
  await select(page, SECOND);
  const other = await page.context().newPage();
  const errors: string[] = [];
  other.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  other.on("pageerror", (error) => errors.push(error.message));
  try {
    await other.goto(appUrl(`#thread=${seededThread ?? ""}`));
    await waitReady(other);
    await sendMessage(other, "Answer from the other client");
    await expect(mark(other, FIRST)).toBeVisible();
    await expect(mark(page, FIRST)).toBeVisible();
    await expect(page.locator(".hdr h2")).toHaveText(SECOND);
    await stop(other);
    await expect(mark(page, FIRST)).toHaveCount(0);
  } finally {
    await other.close();
    expect(errors, "other client's console errors").toEqual([]);
  }
});

test("a window opened after start and reloaded during the reply restores its running mark", async ({ page, open, seededThread }) => {
  await stack.scenario("slow-drip", { holdAfterTokens: 12 });
  await open(`#thread=${seededThread ?? ""}`);
  await waitReady(page);
  await sendMessage(page, "Keep answering while another window opens");
  await page.waitForFunction(() => ((window as unknown as { glPerf?: { deltas: number } }).glPerf?.deltas ?? 0) > 0);
  const observer = await page.context().newPage();
  const errors: string[] = [];
  observer.on("pageerror", error => errors.push(error.message));
  observer.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  try {
    await observer.goto(appUrl(`#thread=${seededThread ?? ""}`));
    await waitReady(observer);
    await select(observer, SECOND);
    await expect(mark(observer, FIRST)).toBeVisible();
    await observer.reload();
    await waitReady(observer);
    await expect(observer.locator(".hdr h2")).toHaveText(SECOND);
    await expect(mark(observer, FIRST)).toBeVisible();
    await observer.screenshot({ path: test.info().outputPath("late-window-running.png") });
    await stop(page);
    await expect(mark(observer, FIRST)).toHaveCount(0);
    await observer.reload();
    await waitReady(observer);
    await expect(mark(observer, FIRST)).toHaveCount(0);
  } finally {
    await observer.close();
    expect(errors, "late window's console errors").toEqual([]);
  }
});

test.describe("running marks on a phone", () => {
  test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

  test("the running mark keeps the drawer row still and leaves its actions clear", async ({ page, open, seededThread }) => {
    await stack.scenario("slow-drip", { holdAfterTokens: 12 });
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    const drawer = async () => {
      await page.getByRole("button", { name: "Open threads" }).tap();
      await expect(page.locator(".app.drawer")).toHaveCount(1);
      await page.locator(".sb").evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
    };
    await drawer();
    const before = await geometry(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".app.drawer")).toHaveCount(0);
    await page.locator("#ta").fill("Keep this phone chat answering");
    await page.getByRole("button", { name: "Send message", exact: true }).tap();
    await page.waitForFunction(() => ((window as unknown as { glPerf?: { deltas: number } }).glPerf?.deltas ?? 0) > 0);
    await drawer();
    await expect(mark(page, FIRST)).toBeVisible();
    expect(await geometry(page), "the running mark keeps the drawer's geometry").toEqual(before);
    const [running, actions] = [await mark(page, FIRST).boundingBox(), await row(page, FIRST).locator(".sb-menu").boundingBox()];
    if (running === null || actions === null) throw new Error("running mark or row actions have no box");
    expect(overlap(running, actions), "the running mark leaves the touch action clear").toBe(false);
    await page.screenshot({ path: test.info().outputPath("running-chat-phone.png"), animations: "disabled" });
    await select(page, FIRST);
    await expect(page.locator(".app.drawer")).toHaveCount(0);
    await stop(page);
    await drawer();
    await expect(mark(page, FIRST)).toHaveCount(0);
    expect(await geometry(page), "stopping keeps the drawer's geometry").toEqual(before);
  });
});
