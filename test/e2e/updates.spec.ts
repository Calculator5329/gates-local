// UI probe only: the existing updater has separate real-clone runtime acceptance.
// Run through the virtual-screen runner, never on the implementation host.
import type { Page, WebSocketRoute } from "@playwright/test";
import { test, expect, sendMessage, stack, waitReady } from "./fixtures.ts";
import { updateFixtureState } from "./update-fixture.ts";

async function updates(page: Page, desktop = true) {
  let route: WebSocketRoute | undefined;
  const fixture = updateFixtureState();
  if (desktop) await page.addInitScript(() => {
    const bridge = {
      updateApprovalVersion: 1 as const,
      getServerUrl: async () => new URLSearchParams(location.search).get("server"),
      onState: () => () => undefined,
      updateAndRestart: async () => { document.documentElement.dataset["updateStarted"] = "yes"; return { ok: true as const }; },
    };
    Object.assign(window, { gatesLocal: bridge });
  });
  await page.routeWebSocket(/\/\?token=/, (socket) => {
    route = socket;
    const server = socket.connectToServer();
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as { method?: string; id: string; params?: { approval?: string } };
      if (message.method === "update.status") socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: { ...fixture.status(), canControl: desktop } }));
      else if (message.method === "update.prepare") socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: fixture.prepare(message.params?.approval ?? "") }));
      else if (message.method === "update.cancel") socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: { cancelled: true } }));
      else if (message.method === "update.dismissResult") socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: fixture.dismiss() }));
      else server.send(raw);
    });
  });
  return {
    show: () => { if (!route) throw new Error("socket not ready"); route.send(JSON.stringify({ type: "push", channel: "update.changed", payload: { ...fixture.show(), canControl: desktop } })); },
    work: fixture.work,
    notice: () => { if (!route) throw new Error("socket not ready"); route.send(JSON.stringify({ type: "push", channel: "update.changed", payload: fixture.notice() })); },
    failure: () => { if (!route) throw new Error("socket not ready"); const value = fixture.failure(); route.send(JSON.stringify({ type: "push", channel: "update.changed", payload: value })); return value.result?.logPath; },
  };
}

for (const width of [1440, 390]) test(`long rollback text and its complete log path fit the chat note at ${width}px`, async ({ page, open }) => {
  await page.setViewportSize({ width, height: 900 });
  const update = await updates(page);
  await open(); await waitReady(page);
  const logPath = update.failure();
  const note = page.getByRole("alert").filter({ hasText: "The update did not finish" });
  await expect(note).toBeVisible();
  await note.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
  expect(await note.evaluate(element => element.scrollWidth <= element.clientWidth), "rollback note overflows sideways").toBe(true);
  expect(await page.locator(".main").evaluate(element => element.scrollWidth <= element.clientWidth), "rollback text widens chat").toBe(true);
  await expect(note.locator(".mono")).toHaveText(logPath ?? "missing log path");
  await page.screenshot({ path: test.info().outputPath(`rollback-note-${width}.png`) });
});

test("AV-05 Settings notice spans the content top and dismissal never shifts its width", async ({ page, open }) => {
  const update = await updates(page);
  await open(); await waitReady(page);
  await page.keyboard.press("Control+Comma");
  await expect(page.locator(".set .set-h h1")).toHaveText("General");
  const geometry = async () => Promise.all([".set", ".set-in", ".set-h"].map(async selector => {
    const box = await page.locator(selector).boundingBox();
    if (!box) throw new Error(`No geometry for ${selector}`);
    return { x: box.x, width: box.width };
  }));
  const before = await geometry();
  update.notice();
  const notice = page.getByRole("status").filter({ hasText: "Gates Local updated" });
  await expect(notice).toBeVisible();
  await notice.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
  expect(await geometry(), "AV-05 notice changed Settings width").toEqual(before);
  const bannerBox = await notice.boundingBox();
  const contentBox = await page.locator(".set-in").boundingBox();
  if (!bannerBox || !contentBox) throw new Error("No Settings notice geometry");
  expect(bannerBox.y + bannerBox.height).toBeLessThanOrEqual(contentBox.y);
  await page.screenshot({ path: test.info().outputPath("settings-notice.png") });
  await notice.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(notice).toHaveCount(0);
  expect(await geometry(), "AV-05 dismissing changed Settings width").toEqual(before);
});

test("update appears beside Settings without moving or resizing the shell", async ({ page, open }) => {
  const update = await updates(page);
  await open();
  await waitReady(page);
  await expect(page.locator(".sb-update")).toHaveCount(0);
  const selectors = [".sb-head", ".sb-list", ".sb-set", ".hdr", "#ta"];
  const before = await Promise.all(selectors.map((s) => page.locator(s).boundingBox()));
  update.show();
  const button = page.getByRole("button", { name: "Update def5678", exact: true });
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute("title", /Faster chat/);
  const after = await Promise.all(selectors.map((s) => page.locator(s).boundingBox()));
  expect(before.every((box) => box !== null)).toBe(true);
  expect(after).toEqual(before);
  await button.click();
  await expect(page.locator("html")).toHaveAttribute("data-update-started", "yes");
  await expect(page.locator(".sb-update")).toBeDisabled();
});

test("a reply running brings a confirmation; cancel keeps writing and accept shares the action", async ({ page, open }) => {
  const update = await updates(page);
  await stack.scenario("models", { tokenDelayMs: 120 });
  await open();
  await waitReady(page);
  await sendMessage(page, "A slow reply");
  await expect(page.locator(".writing")).toBeVisible();
  update.work(["1 running reply (including other windows)"]);
  update.show();
  const button = page.getByRole("button", { name: "Update def5678", exact: true });
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("1 running reply");
    await dialog.dismiss();
  });
  await button.click();
  await expect(page.locator("html")).not.toHaveAttribute("data-update-started", "yes");
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  page.once("dialog", (dialog) => dialog.accept());
  await button.click();
  await expect(page.locator("html")).toHaveAttribute("data-update-started", "yes");
});

test("a phone has status and computer-update instructions without update controls", async ({ page, open }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const update = await updates(page, false);
  await open();
  await waitReady(page);
  await page.keyboard.press("Control+Comma");
  await expect(page.locator(".set")).toBeVisible();
  update.show();
  // The settings section may start on the phone section list.
  const general = page.locator(".set-list").getByRole("button", { name: /General/ });
  if (await general.isVisible()) await general.click();
  await expect(page.getByRole("button", { name: "Check for updates", exact: true })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Check for updates automatically", exact: true })).toHaveCount(0);
  await expect(page.locator(".sb-update")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Update and restart", exact: true })).toHaveCount(0);
  await expect(page.getByText("To install it, close Gates Local on the computer it runs on", { exact: false })).toBeVisible();
});
