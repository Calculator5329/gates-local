// UI probe only: the existing updater has separate real-clone runtime acceptance.
// Run through the virtual-screen runner, never on the implementation host.
import type { Page, WebSocketRoute } from "@playwright/test";
import { test, expect, sendMessage, stack, waitReady } from "./fixtures.ts";
import { updateFixtureState } from "./update-fixture.ts";

test.use({ video: "on" });

async function updates(page: Page, desktop = true, successful = false) {
  let route: WebSocketRoute | undefined;
  const fixture = updateFixtureState();
  if (successful) fixture.notice();
  if (desktop) await page.addInitScript(() => {
    const bridge = {
      updateApprovalVersion: 2 as const,
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

test("AV-05 success stays silent; failure spans the Settings top and dismisses without a width shift", async ({ page, open }) => {
  const update = await updates(page, true, true);
  await open(); await waitReady(page);
  await expect(page.locator(".sb-foot .upd")).toHaveAccessibleName("Check for updates");
  await expect(page.locator(".upd-note")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("startup-success-silent.png") });
  await page.keyboard.press("Control+Comma");
  await expect(page.locator(".set .set-h h1")).toHaveText("General");
  await expect(page.locator(".set").getByText("abc1234", { exact: true })).toBeVisible();
  const geometry = async () => Promise.all([".set", ".set-in", ".set-h"].map(async selector => {
    const box = await page.locator(selector).boundingBox();
    if (!box) throw new Error(`No geometry for ${selector}`);
    return { x: box.x, width: box.width };
  }));
  const before = await geometry();
  update.notice();
  await expect(page.locator(".upd-note")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(0);
  expect(await geometry(), "AV-05 successful update changed Settings width").toEqual(before);
  await page.screenshot({ path: test.info().outputPath("settings-success-silent.png") });
  update.failure();
  const notice = page.getByRole("alert").filter({ hasText: "The update did not finish" });
  await expect(notice).toBeVisible();
  await notice.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
  expect(await geometry(), "AV-05 notice changed Settings width").toEqual(before);
  const bannerBox = await notice.boundingBox();
  const contentBox = await page.locator(".set-in").boundingBox();
  if (!bannerBox || !contentBox) throw new Error("No Settings notice geometry");
  expect(bannerBox.y + bannerBox.height).toBeLessThanOrEqual(contentBox.y);
  await page.screenshot({ path: test.info().outputPath("settings-failure-notice.png") });
  await notice.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(notice).toHaveCount(0);
  expect(await geometry(), "AV-05 dismissing changed Settings width").toEqual(before);
});

test("an update turns the footer's update icon to Update without moving or resizing the shell", async ({ page, open }) => {
  const update = await updates(page);
  await open();
  await waitReady(page);
  // the desktop app always has the update icon, idle until there is something to update to
  await expect(page.locator(".sb-foot .upd")).toHaveAccessibleName("Check for updates");
  const selectors = [".sb-head", ".sb-list", ".sb-foot", ".sb-foot .upd", ".hdr", "#ta"];
  const before = await Promise.all(selectors.map((s) => page.locator(s).boundingBox()));
  update.show();
  const button = page.getByRole("button", { name: "Update to def5678", exact: true });
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute("data-tip", /Faster chat/);
  const after = await Promise.all(selectors.map((s) => page.locator(s).boundingBox()));
  expect(before.every((box) => box !== null)).toBe(true);
  expect(after).toEqual(before);
  await button.click();
  await page.getByRole("group", { name: "Confirm update" }).getByRole("button", { name: "Update and restart" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-update-started", "yes");
  await expect(page.locator(".sb-foot .upd")).toBeDisabled();
});

test("a reply running: one ask, in the footer's panel, that names the reply; cancel keeps writing and accept starts it", async ({ page, open }) => {
  const update = await updates(page);
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await stack.scenario("models", { tokenDelayMs: 120 });
  await open();
  await waitReady(page);
  await sendMessage(page, "A slow reply");
  await expect(page.locator(".writing")).toBeVisible();
  update.work(["1 running reply (including other windows)"]);
  update.show();
  const button = page.getByRole("button", { name: "Update to def5678", exact: true });
  const ask = page.getByRole("group", { name: "Confirm update" });
  await button.click();
  await expect(ask.locator("li")).toHaveText(["1 reply stops. Its text is kept.", "Falls back to abc1234 if a step fails."]);
  await expect(ask).toContainText("Update to def5678 and restart?");
  await page.screenshot({ path: test.info().outputPath("update-confirm-reply-running.png"), animations: "disabled", caret: "hide" });
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(ask).toHaveCount(0);
  await expect(page.locator(".writing")).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-update-started", "yes");
  await button.click();
  await ask.getByRole("button", { name: "Update and restart" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-update-started", "yes");
  expect(dialogs, "one ask: no native prompt after the panel").toEqual([]);
});

test("what is running changes behind an open ask: the panel's words follow and its button waits a moment, still one ask", async ({ page, open }) => {
  const update = await updates(page);
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await open();
  await waitReady(page);
  update.show();
  const ask = page.getByRole("group", { name: "Confirm update" });
  const go = ask.getByRole("button", { name: "Update and restart" });
  await page.getByRole("button", { name: "Update to def5678", exact: true }).click();
  await expect(ask.locator("li")).toHaveText(["Falls back to abc1234 if a step fails."]);
  await expect(go).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("footer-confirm-idle.png"), animations: "disabled", caret: "hide" });
  const height = () => ask.evaluate((e) => e.getBoundingClientRect().height);
  const one = await height();
  // announced: a new approval arrives while the panel is open
  update.work(["model download: qwen3:14b"]);
  update.show();
  await expect(ask.locator("li").first()).toHaveText("Download of qwen3:14b stops. It resumes.");
  await expect(ask.getByRole("status")).toContainText("Changed: Download of qwen3:14b stops.");
  await expect(go).toBeDisabled();
  const two = await height();
  expect(two, "a line was added").toBeGreaterThan(one);
  await expect(go).toBeEnabled({ timeout: 3000 });
  expect(await height(), "the mark goes without moving anything").toBe(two);
  // unannounced: the server's approval moved on before the click landed
  update.work(["2 image generation jobs (queued or running)"]);
  await go.click();
  await expect(ask.locator("li").first()).toHaveText("2 image jobs stop.");
  await expect(page.locator("html")).not.toHaveAttribute("data-update-started", "yes");
  await expect(go).toBeEnabled({ timeout: 3000 });
  await go.click();
  await expect(page.locator("html")).toHaveAttribute("data-update-started", "yes");
  expect(dialogs).toEqual([]);
});

test("a phone has status and computer-update instructions without update controls", async ({ page, open }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const update = await updates(page, false, true);
  await open();
  await waitReady(page);
  await page.keyboard.press("Control+Comma");
  await expect(page.locator(".set")).toBeVisible();
  // The settings section may start on the phone section list.
  const general = page.locator(".set-list").getByRole("button", { name: /General/ });
  if (await general.isVisible()) await general.click();
  await expect(page.locator(".set").getByText("abc1234", { exact: true })).toBeVisible();
  await expect(page.locator(".upd-note")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("phone-settings-success-silent.png") });
  update.show();
  await expect(page.getByRole("button", { name: "Check for updates", exact: true })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Check for updates automatically", exact: true })).toHaveCount(0);
  await expect(page.locator(".sb-foot .upd")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Update and restart", exact: true })).toHaveCount(0);
  await expect(page.getByText("To install it, close Gates Local on the computer it runs on", { exact: false })).toBeVisible();
  update.failure();
  const notice = page.getByRole("alert").filter({ hasText: "The update did not finish" });
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(notice).toHaveCount(0);
});
