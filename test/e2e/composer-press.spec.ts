/// <reference lib="dom" />
// Draft-preserving Stop and real held gestures across primary-action changes.
import type { Page } from "@playwright/test";
import { SERVER_PORT } from "./env.ts";
import { expect, stack, test, waitReady } from "./fixtures.ts";

declare global {
  interface Window {
    composerRequests: string[];
    composerKeys: { key: string; repeat: boolean }[];
    composerPointerTargets: string[];
  }
}

test.use({ seed: 2, video: process.env["GL_E2E_RECORD"] || process.env["GL_FLICKER_MEASURE"] ? "on" : "off" });

/** Observe admission/cancellation synchronously, before an async RPC can hide a stray click. */
async function watchRequests(page: Page) {
  await page.addInitScript(() => {
    window.composerRequests = [];
    window.composerKeys = [];
    window.composerPointerTargets = [];
    document.addEventListener("keydown", (event) => window.composerKeys.push({ key: event.key, repeat: event.repeat }));
    document.addEventListener("pointerdown", (event) => {
      if (event.target instanceof Element) window.composerPointerTargets.push(event.target.tagName);
    });
    const nativeSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string") {
        const frame = JSON.parse(data) as { type?: string; method?: string };
        if (frame.type === "request" && frame.method) window.composerRequests.push(frame.method);
      }
      nativeSend.call(this, data);
    };
  });
}

/** The composer's box: compact Stop appearing must not move or resize it. */
const composerBounds = (page: Page) => page.locator(".composer").evaluate((el) => {
  const rect = el.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
});

// Hover scales the paint around its center; compare layout independently of that animation.
const primaryBounds = (page: Page) => page.locator(".composer button.send").evaluate((button: HTMLButtonElement) => {
  const rect = button.getBoundingClientRect();
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), width: button.offsetWidth, height: button.offsetHeight };
});

async function startHeld(page: Page, open: (hash?: string) => Promise<void>, thread: string | null, touch = false) {
  await open(`#thread=${thread ?? ""}`);
  await waitReady(page);
  await stack.scenario("slow-drip", { holdAfterTokens: 46 });
  await page.locator("#ta").fill("Keep this reply running");
  const primary = page.locator(".composer button.send");
  if (touch) await primary.tap();
  else await primary.click();
  // on touch the arrow keeps its slot while a reply runs, and Stop has its own
  await expect(primary).toHaveAccessibleName(touch ? "Queue message" : "Stop");
  await expect(page.locator(".turn.a").last().locator(".md ul li")).toHaveCount(3);
  return primary;
}

test("CP-01 editing queued text keeps compact Stop reachable without losing the edit", async ({ page, open, seededThread }, info) => {
  const primary = await startHeld(page, open, seededThread);
  const before = await primaryBounds(page);
  const composerBefore = await composerBounds(page);
  await page.locator("#ta").fill("Keep this queued draft");
  await page.locator("#ta").press("Enter");
  await page.locator(".qt-r [data-edit-queued]").click();
  await expect(primary).toHaveAccessibleName("Update queued message");
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible();
  await expect(stop).toBeInViewport();
  await expect(page.locator(".composer button.send")).toHaveCount(1);
  expect(await primaryBounds(page)).toEqual(before);
  expect(await composerBounds(page)).toEqual(composerBefore);
  await page.screenshot({ path: info.outputPath("queued-edit-stop.png") });
  await stop.click();
  await expect(page.locator("#ta")).toHaveValue("Keep this queued draft");
  await expect(page.locator(".qt-r")).toContainText("Editing in the composer");
  await expect(primary).toHaveAccessibleName("Update queued message");
  await expect(stop).toHaveCount(0);
});

test.describe("a touch draft", () => {
  test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  test("CP-01 typing keeps compact Stop reachable without clearing or queueing the draft", async ({ page, open, seededThread }, info) => {
    // A short visual area approximates the space left above a phone keyboard.
    await page.setViewportSize({ width: 412, height: 480 });
    const primary = await startHeld(page, open, seededThread, true);
    const before = await primaryBounds(page);
    const composerBefore = await composerBounds(page);
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    await expect(stop, "Stop has its slot before anything is typed").toBeVisible();
    const stopBefore = await stop.boundingBox();
    await page.locator("#ta").fill("An unfinished phone draft");
    await expect(primary).toHaveAccessibleName("Queue message");
    await expect(stop).toBeVisible();
    await expect(stop).toBeInViewport();
    const bounds = await stop.boundingBox();
    expect(bounds, "typing leaves Stop where it was").toEqual(stopBefore);
    expect(Math.min(bounds?.width ?? 0, bounds?.height ?? 0)).toBeGreaterThanOrEqual(44);
    expect(await primaryBounds(page)).toEqual(before);
    expect(await composerBounds(page), "the composer keeps its box when compact Stop appears").toEqual(composerBefore);
    await expect(page.locator(".composer button.send")).toHaveCount(1);
    await page.screenshot({ path: info.outputPath("phone-draft-stop.png") });
    await stop.tap();
    await expect(page.locator("#ta")).toHaveValue("An unfinished phone draft");
    await expect(page.locator(".qt-r")).toHaveCount(0);
    await expect(primary).toHaveAccessibleName("Send message");
    await expect(stop).toHaveCount(0);
  });
});

for (const gesture of ["pointer", "Space"] as const) {
  test(`CP-02 a ${gesture} press begun on Stop never sends when the reply ends before release`, async ({ page, open, seededThread }, info) => {
    await watchRequests(page);
    // Hold the terminal frame so completion cannot race ahead of the physical press.
    let finish: (() => void) | undefined;
    await page.routeWebSocket((url) => url.port === String(SERVER_PORT), (ws) => {
      const server = ws.connectToServer();
      server.onMessage((message) => {
        const frame = typeof message === "string" ? JSON.parse(message) as { type?: string; channel?: string; payload?: { event?: { type?: string } } } : null;
        if (frame?.type === "push" && frame.channel === "chat.event" && frame.payload?.event?.type === "done") {
          finish = () => ws.send(message);
        } else ws.send(message);
      });
    });
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    await stack.scenario("models", { tokenDelayMs: 35, firstTokenDelayMs: 0 });
    await page.locator("#ta").fill("A finite reply");
    const primary = page.locator(".composer button.send");
    await primary.click();
    await expect(primary).toHaveAccessibleName("Stop");
    await expect.poll(() => finish !== undefined).toBe(true);
    await page.locator("#ta").fill("Unfinished text must stay here");
    const before = await page.evaluate(() => window.composerRequests.filter((method) => method === "turns.blocking" || method === "chat.send"));
    expect(before, "the request observer must see the original send").toContain("chat.send");
    if (gesture === "pointer") {
      const box = await primary.boundingBox();
      if (!box) throw new Error("Missing primary button");
      // Press the persistent button padding, not its square icon which is removed on completion.
      await page.mouse.move(box.x + 4, box.y + box.height / 2);
      await page.mouse.down();
      expect(await page.evaluate(() => window.composerPointerTargets.at(-1))).toBe("BUTTON");
    } else {
      await primary.focus();
      await page.keyboard.down("Space");
    }
    await expect(primary).toHaveAccessibleName("Stop");
    finish?.();
    await expect(primary).toHaveAccessibleName("Send message", { timeout: 15_000 });
    if (gesture === "pointer") await page.mouse.up();
    else await page.keyboard.up("Space");
    expect(await page.evaluate(() => window.composerRequests.filter((method) => method === "turns.blocking" || method === "chat.send"))).toEqual(before);
    await expect(page.locator("#ta")).toHaveValue("Unfinished text must stay here");
    await expect(primary).toHaveAccessibleName("Send message");
    await page.screenshot({ path: info.outputPath(`released-${gesture}.png`) });
  });
}

test("CP-03 holding Enter on Send cannot cancel; releasing and pressing Enter again can stop", async ({ page, open, seededThread }, info) => {
  await watchRequests(page);
  await open(`#thread=${seededThread ?? ""}`);
  await waitReady(page);
  await stack.scenario("slow-drip", { holdAfterTokens: 46 });
  await page.locator("#ta").fill("Hold Enter on Send");
  const primary = page.locator(".composer button.send");
  await primary.focus();
  await page.keyboard.down("Enter");
  await expect(primary).toHaveAccessibleName("Stop");
  await expect(primary).toBeFocused();
  await expect(page.locator(".turn.a").last().locator(".md ul li")).toHaveCount(3);
  expect(await page.evaluate(() => window.composerRequests)).toContain("chat.send");
  // Another keydown while still held is a real browser repeat, not a synthetic click detail.
  await page.keyboard.down("Enter");
  expect(await page.evaluate(() => window.composerKeys.some((event) => event.key === "Enter" && event.repeat))).toBe(true);
  expect(await page.evaluate(() => window.composerRequests.filter((method) => method === "chat.cancel"))).toHaveLength(0);
  await expect(primary).toHaveAccessibleName("Stop");
  await page.screenshot({ path: info.outputPath("held-enter.png") });
  await page.keyboard.up("Enter");
  await page.keyboard.press("Enter");
  await expect(primary).toHaveAccessibleName("Send message");
  expect(await page.evaluate(() => window.composerRequests.filter((method) => method === "chat.cancel"))).toHaveLength(1);
});

test("CP-02 a pointer-hovered, focused Send clears its old tooltip after keyboard activation", async ({ page, open, seededThread }) => {
  await open(`#thread=${seededThread ?? ""}`);
  await waitReady(page);
  await stack.scenario("slow-drip", { holdAfterTokens: 46 });
  await page.locator("#ta").fill("Keep the action hint current");
  const primary = page.locator(".composer button.send");
  await primary.hover();
  await primary.focus();
  await expect(page.locator("#tip.open")).toHaveText("Send (Enter)");
  await page.keyboard.down("Enter");
  await expect(primary).toHaveAccessibleName("Stop");
  await expect(primary).toBeFocused();
  // Replacing the icon under a stationary pointer can open the new hint again.
  // An open hint must describe Stop, never the previous Send action.
  await expect(page.locator("#tip.open").filter({ hasText: "Send (Enter)" })).toHaveCount(0);
  if (await page.locator("#tip.open").count()) {
    await expect(page.locator("#tip.open")).toHaveText("Stop. Enter queues your message after this reply");
  }
  await page.keyboard.up("Enter");
});

for (const key of ["Enter", "Space"] as const) {
  test(`CQ-02 a fresh ${key} works after the previous Enter keyup was lost`, async ({ page, open, seededThread }) => {
    await watchRequests(page);
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    await stack.scenario("slow-drip", { holdAfterTokens: 46 });
    await page.locator("#ta").fill("Release Enter outside this window");
    const primary = page.locator(".composer button.send");
    await primary.focus();
    await page.keyboard.down("Enter");
    await expect(primary).toHaveAccessibleName("Stop");
    await expect(primary).toBeFocused();
    await expect(page.locator(".turn.a").last().locator(".md ul li")).toHaveCount(3);
    // The browser releases the key, but the button misses keyup as when another window receives it.
    await page.evaluate(() => window.addEventListener("keyup", (event) => event.stopImmediatePropagation(), { capture: true, once: true }));
    await page.keyboard.up("Enter");
    expect(await page.evaluate(() => window.composerRequests.filter((method) => method === "chat.cancel"))).toHaveLength(0);
    await page.keyboard.press(key);
    expect(await page.evaluate(() => window.composerKeys.at(-1))).toEqual({ key: key === "Space" ? " " : "Enter", repeat: false });
    await expect(primary).toHaveAccessibleName("Send message");
    expect(await page.evaluate(() => window.composerRequests.filter((method) => method === "chat.cancel"))).toHaveLength(1);
  });
}
