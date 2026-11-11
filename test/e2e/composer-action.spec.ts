/// <reference lib="dom" />
// One primary node through Send, Stop, Queue and Update. Interaction journeys
// complement the real-composer render matrix in Composer.test.ts.
import { expect, stack, test, waitReady } from "./fixtures.ts";

test.use({ seed: 2, video: process.env["GL_E2E_RECORD"] || process.env["GL_FLICKER_MEASURE"] ? "on" : "off" });

test("one primary button keeps its node, position and keyboard focus across Send, Stop and Update", async ({ page, open, seededThread }) => {
  await open(`#thread=${seededThread ?? ""}`);
  await waitReady(page);
  await stack.scenario("slow-drip", { holdAfterTokens: 46 });
  const action = page.locator(".composer button.send");
  await expect(action).toHaveCount(1);
  await expect(action).toHaveAccessibleName("Send message");
  await page.locator("#ta").fill("A reply to queue behind");
  await action.focus();
  const node = await action.elementHandle();
  if (!node) throw new Error("Missing primary button");
  const before = await action.boundingBox();
  await action.press("Enter");
  await expect(action).toHaveCount(1);
  await expect(action).toHaveAccessibleName("Stop");
  await expect(action).toHaveAttribute("data-tip", /Enter queues/);
  await expect(action).toBeFocused();
  expect(await action.boundingBox()).toEqual(before);
  expect(await action.evaluate((el, original) => el === original, node)).toBe(true);

  // Desktop typing keeps Stop; Enter queues, without interrupting the reply.
  await page.locator("#ta").fill("Keep this for later");
  await expect(action).toHaveAccessibleName("Stop");
  await page.locator("#ta").press("Enter");
  await expect(page.locator(".qt-r")).toHaveCount(1);
  await expect(action).toHaveCount(1);
  await expect(action).toHaveAccessibleName("Stop");
  await page.locator(".qt-r [data-edit-queued]").click();
  await expect(action).toHaveCount(1);
  await expect(action).toHaveAccessibleName("Update queued message");
  await page.locator("#ta").fill("Edited for later");
  await action.focus();
  await action.press("Enter");
  await expect(page.locator(".qt-r")).toContainText("Edited for later");
  await expect(action).toHaveAccessibleName("Stop");
  await expect(action).toBeFocused();
  expect(await action.evaluate((el, original) => el === original, node)).toBe(true);
  await action.press("Space");
  await expect(action).toHaveAccessibleName("Send message");
  await expect(action).toHaveCount(1);
  await expect(action).toBeFocused();
  await expect(page.locator(".qt-r")).toContainText("On hold");
});

test("the second click of Send's double-click cannot stop the reply it just started", async ({ page, open, seededThread }) => {
  const cancellations: string[] = [];
  await page.routeWebSocket(/127\.0\.0\.1:5286/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (typeof message === "string" && (JSON.parse(message) as { method?: string }).method === "chat.cancel") cancellations.push(message);
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });
  await open(`#thread=${seededThread ?? ""}`);
  await waitReady(page);
  await stack.scenario("slow-drip", { holdAfterTokens: 46 });
  await page.locator("#ta").fill("Double click once");
  const action = page.locator(".composer button.send");
  const box = await action.boundingBox();
  if (!box) throw new Error("Missing primary button bounds");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.click(x, y, { clickCount: 1 });
  await expect(action).toHaveAccessibleName("Stop");
  // Force the race: deliver the second physical click after Send became Stop,
  // carrying the browser's double-click count on that same DOM node.
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  await expect(page.locator(".turn.a").last().locator(".md ul li")).toHaveCount(3);
  expect(cancellations).toHaveLength(0);
  await expect(action).toHaveAccessibleName("Stop");
  await expect(action).toHaveCount(1);
  await expect(page.locator(".turn.a:not(.interrupted) .a-act.stop"), "no reply was stopped").toHaveCount(0);
  // A fresh, intentional Stop still works.
  await action.click();
  await expect(action).toHaveAccessibleName("Send message");
  await expect.poll(() => cancellations.length).toBe(1);
});

test.describe("a fresh chat", () => {
  test.use({ seed: 0 });
  test("keyboard focus survives creating the first thread and returning from Stop", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await stack.scenario("slow-drip", { holdAfterTokens: 46 });
    const action = page.locator(".composer button.send");
    await page.locator("#ta").fill("First thread");
    await action.focus();
    await action.press("Enter");
    await expect(action).toHaveAccessibleName("Stop");
    await expect(action).toBeFocused();
    await action.press("Space");
    await expect(action).toHaveAccessibleName("Send message");
    await expect(action).toBeFocused();
  });
});

test.describe("a touch keyboard", () => {
  test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  test("Enter inserts a newline; the queue arrow and Stop hold their own slots through typing, clearing and queueing", async ({ page, open, seededThread }, info) => {
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    await stack.scenario("slow-drip", { holdAfterTokens: 46 });
    const action = page.locator(".composer button.send");
    const stop = page.locator(".composer .stop-sq");
    await page.locator("#ta").fill("A touch reply");
    await action.tap();
    await expect(action).toHaveAccessibleName("Queue message");
    await expect(action, "the arrow is off while the draft is empty").toHaveAttribute("aria-disabled", "true");
    await expect(stop).toHaveAccessibleName("Stop");
    const boxes = async () => [await action.boundingBox(), await stop.boundingBox()];
    const still = await boxes();
    await page.locator("#ta").fill("Next line");
    await page.locator("#ta").press("Enter");
    await expect(page.locator("#ta")).toHaveValue("Next line\n");
    await expect(page.locator(".qt-r")).toHaveCount(0);
    await expect(action).toHaveAccessibleName("Queue message");
    await expect(action).not.toHaveAttribute("aria-disabled", "true");
    await expect(action).toHaveCount(1);
    expect(await boxes()).toEqual(still);
    await page.locator("#ta").fill("");
    await expect(action).toHaveAttribute("aria-disabled", "true");
    expect(await boxes()).toEqual(still);
    await page.locator("#ta").fill("Queued from touch");
    await action.tap();
    await expect(page.locator(".qt-r")).toContainText("Queued from touch");
    await expect(action).toHaveAccessibleName("Queue message");
    await expect(action).toHaveCount(1);
    expect(await boxes()).toEqual(still);
    await page.locator(".qt-r [data-edit-queued]").tap();
    await expect(action).toHaveAccessibleName("Update queued message");
    await page.locator("#ta").fill("Updated on touch");
    await action.tap();
    await expect(page.locator(".qt-r")).toContainText("Updated on touch");
    await expect(action).toHaveAccessibleName("Queue message");
    await expect(stop).toBeVisible();
    await page.screenshot({ path: info.outputPath("touch-queue-updated.png") });
  });
});
