/// <reference lib="dom" />
// On a phone Settings lies over the chat, which stays mounted under it so closing gives
// back its scroll and a reply still following. Nothing of the chat may paint through:
// an open thought sets visibility:visible on itself, which beats a hidden parent,
// so a live thought once drew its words over Settings (chat row 22). Wider than a phone
// Settings is a pop-up and the chat shows under its blur (popups.spec.ts).
import { writeFile } from "node:fs/promises";
import { createClient } from "@gates-local/contracts";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";
import { release } from "./threads-support.ts";
import { painted, settled } from "./waits.ts";

test.use({ screenshot: "only-on-failure", seed: "work-fold", viewport: { width: 390, height: 844 } });

/** A Library file and tools on, so the fake model is offered a tool to call. */
async function libraryOn(page: Page, info: TestInfo): Promise<void> {
  const server = new URL(page.url()).searchParams.get("server");
  if (!server) throw new Error("No test server");
  const client = createClient(new WebSocket(server));
  const file = info.outputPath("notes.md");
  await writeFile(file, "# Notes\n\nNothing to see.\n");
  await client.call("sources.add", { kind: "file", path: file });
  await client.call("settings.update", { tools: true });
}

/** Release held rounds until the chip has counted `n` calls. */
async function untilCalls(chip: Locator, n: number): Promise<void> {
  const name = new RegExp(`\\b${n} tool calls?\\b`);
  await expect.poll(async () => {
    if (name.test((await chip.getAttribute("aria-label")) ?? "")) return true;
    await release();
    return false;
  }, { timeout: 20_000, intervals: [50] }).toBe(true);
}

/** Every element under the hidden chat that the browser would still paint, by class and first words. */
const paintsThrough = (page: Page) => page.locator(".stage").evaluate((stage) =>
  [stage, ...stage.querySelectorAll("*")]
    .filter((n) => n.checkVisibility({ visibilityProperty: true, opacityProperty: true }))
    .map((n) => `${n.tagName.toLowerCase()}.${[...n.classList].join(".")} ${(n.textContent ?? "").trim().slice(0, 40)}`));

// Guards a shipped bug fix (chat row 22): thoughts showed through Settings.
test("a live thought and an opened one stay under Settings, and come back with the chat", async ({ page, open, seededThread }, info) => {
  await open(`#thread=${seededThread ?? ""}`); await waitReady(page);
  await libraryOn(page, info);
  await stack.scenario("slow-drip", { toolCalls: 3, quietToolRounds: 1, tokenDelayMs: 1, firstTokenDelayMs: 0, holdThinkingAfterTokens: 4 });
  await sendMessage(page, "Use a tool to check my notes");
  const reply = page.locator(".turn.a").last();
  const chip = reply.locator("button.think");
  await untilCalls(chip, 1);
  await chip.click();
  const items = reply.getByRole("list", { name: "Steps" }).locator(":scope > li");
  // round 2 is held open and growing; round 1 is closed, so open it too
  await expect(items.nth(2).locator(".think-body")).toBeVisible();
  await items.nth(0).locator(".th-line").click();
  await expect(items.nth(0).locator(".think-body")).toBeVisible();
  // round 1 has finished opening, which pushes round 2 down; bring the live thought on screen and read its place as drawn
  await settled(page, items.nth(0).locator(".think-body"));
  const liveBody = items.nth(2).locator(".think-body");
  await liveBody.scrollIntoViewIfNeeded();
  await painted(page);
  const live = await liveBody.boundingBox();
  if (live === null) throw new Error("No live thought on screen");
  const point = { x: live.x + live.width / 2, y: live.y + live.height / 2 };
  expect(point.y, "the live thought's middle is on screen").toBeGreaterThan(0);
  expect(point.y, "the live thought's middle is on screen").toBeLessThan(page.viewportSize()?.height ?? 0);

  await page.keyboard.press("Control+Comma");
  await expect(page.locator(".set")).toBeVisible();
  expect(await paintsThrough(page), "nothing of the chat paints through Settings").toEqual([]);
  // what is under the pointer where the live thought was is Settings, not the thought; a point off
  // the page names nothing, so the three answers are kept apart
  const under = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return el === null ? "nothing" : el.closest(".stage") !== null ? "chat" : el.closest(".set") !== null ? "settings" : `other: ${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`;
  }, point);
  expect(under, "the live thought's place belongs to Settings").toBe("settings");

  await page.keyboard.press("Escape");
  await expect(page.locator(".set")).toHaveCount(0);
  await expect(items.nth(2).locator(".think-body")).toBeVisible();
  await expect(items.nth(0).locator(".think-body")).toBeVisible();
  await release();
});
