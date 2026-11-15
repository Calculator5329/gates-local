/// <reference lib="dom" />
// One primary node through Send, Stop, Queue and Update. Interaction journeys
// complement the real-composer render matrix in Composer.test.ts. No "Reply
// running" line, and the composer holds still as a reply starts and ends.
import { expect, stack, test, waitReady } from "./fixtures.ts";

test.use({ seed: 2, video: process.env["GL_E2E_RECORD"] || process.env["GL_FLICKER_MEASURE"] ? "on" : "off" });

// Guards the owner's ruling: one Send button that becomes Stop and Update in place.
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
  await expect(action).toHaveAttribute("data-tip", "Stop");
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

// Guards a shipped bug fix: a double-click on Send must not stop the reply it started.
test("the second click of Send's double-click cannot stop the reply it just started", async ({ page, open, seededThread }) => {
  const cancellations: string[] = [];
  await page.routeWebSocket(/127\.0\.0\.1:5286/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (typeof message === "string" && (JSON.parse(message) as { method?: string }).method === "reply.stop") cancellations.push(message);
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

test.describe("a touch keyboard", () => {
  test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  // Guards the owner's queue ruling on touch: Queue and Stop keep their own slots and take every press.
  test("Enter inserts a newline; the queue arrow and Stop hold their own slots through typing, clearing and queueing", async ({ page, open, seededThread }) => {
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
  });
});

test.describe("the reply-running line", () => {
  // Guards the owner's ruling (N05): no "Reply running" line, and the composer does not move as a reply starts and ends.
  test("is gone; the composer does not move as a reply starts and ends, and Stop stays one click away while editing", async ({ page, open, seededThread }) => {
    await open(`#thread=${seededThread ?? ""}`); await waitReady(page);
    const top = () => page.locator(".composer").evaluate(el => el.getBoundingClientRect().top);
    const bottom = () => page.locator(".composer").evaluate(el => el.getBoundingClientRect().bottom);
    const before = await top(), under = await bottom();
    await stack.scenario("slow-drip", { holdAfterTokens: 46 });
    await page.locator("#ta").fill("Keep this reply running");
    const primary = page.locator(".composer button.send");
    await primary.click();
    await expect(primary).toHaveAccessibleName("Stop");
    await expect(page.locator(".turn.a").last().locator(".md ul li")).toHaveCount(3);
    expect(await top(), "a reply starting leaves the composer where it was").toBe(before);
    const inBox = await page.locator("#ta").evaluate(el => el.getBoundingClientRect().bottom - el.closest(".composer")!.getBoundingClientRect().bottom);
    await expect(page.getByText("Reply running", { exact: true })).toHaveCount(0);
    await expect(page.locator("[data-running-status]")).toHaveCount(0);
    await expect(page.locator(".composer .stop-sq"), "the main button is Stop").toHaveCount(0);
    // A desktop draft keeps Stop as the main button (Enter queues); editing a queued message is where Stop moves aside, into Dictate's square.
    await page.locator("#ta").fill("Keep this queued draft");
    await page.locator("#ta").press("Enter");
    const v = await page.locator(".composer .voice").boundingBox();
    await page.locator(".qt-r [data-edit-queued]").click();
    await expect(primary).toHaveAccessibleName("Update queued message");
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    await expect(stop).toBeVisible();
    await expect(stop).toHaveAttribute("data-tip", "Stop");
    expect(await stop.boundingBox(), "Dictate's square").toEqual(v);
    await expect(page.locator(".composer .voice"), "Dictate gives its square to Stop while the edit lasts").toHaveCount(0);
    await stop.click();
    await expect(primary).toHaveAccessibleName("Update queued message");
    await expect(page.locator("#ta")).toHaveValue("Keep this queued draft");
    await expect(stop).toHaveCount(0);
    // the queued message is still on its shelf, which the composer grew upward to hold (chat row 36): its foot is what holds still
    expect(await bottom(), "the reply ending leaves the composer's foot where it was").toBe(under);
    expect(await page.locator("#ta").evaluate(el => el.getBoundingClientRect().bottom - el.closest(".composer")!.getBoundingClientRect().bottom), "and the box in it").toBe(inBox);
  });
});
