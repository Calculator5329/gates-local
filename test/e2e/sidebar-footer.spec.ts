// The sidebar footer is one row of four icon buttons: Settings, Models, Usage and,
// in the desktop app, the update icon at the far right. Its boxes never move
// between states or between chat and Settings, it holds no words, and every
// word it has to say is in a tooltip (data-tip) and the accessible name.
import { expect, test, waitReady } from "./fixtures.ts";
import { QWEN14, QWEN4, desktopBridge, footerBoxes, footerSocket, footerWords } from "./footer-fixture.ts";

const settings = (page: import("@playwright/test").Page) => page.locator(".sb-foot").getByRole("button", { name: /^Settings/ });
const models = (page: import("@playwright/test").Page) => page.locator(".sb-foot").getByRole("button", { name: /^Models/ });

// Guards the owner's ruling on the footer: one row of icon buttons that never move.
test("one row of four icon buttons whose boxes never move, in any state or in Settings", async ({ page, open }) => {
  await desktopBridge(page);
  const s = await footerSocket(page);
  await open();
  await waitReady(page);
  const buttons = page.locator(".sb-foot button.ibtn");
  await expect(buttons).toHaveCount(4);
  const first = await footerBoxes(page);
  // one row: every button on the same line, the update icon at the far right
  expect(new Set(first.buttons.map((b) => b[1])).size).toBe(1);
  const [fx, , fw] = first.foot as [number, number, number, number];
  const last = first.buttons[3] as [number, number, number, number];
  expect(fx + fw - (last[0] + last[2])).toBeLessThanOrEqual(9);
  expect(await footerWords(page)).toEqual([]);

  const same = async (what: string) => {
    expect(await footerBoxes(page), `${what} moved the footer`).toEqual(first);
    expect(await footerWords(page), `${what} put words in the footer`).toEqual([]);
  };
  s.pull(QWEN14);
  await expect(models(page)).toHaveAttribute("data-tip", /Downloading Qwen 3 14B/);
  await same("a download");
  s.pull(QWEN4);
  await expect(models(page)).toHaveAttribute("data-tip", /Downloading Qwen 3\.5 4B/);
  await same("two downloads");
  s.pull({ ...QWEN4, state: "error", completedBytes: 0, message: "no space left on device" });
  await expect(models(page).locator(".fdot.red")).toHaveCount(1);
  await same("a failed download");
  const labels = { available: "Update to def5678", updating: "Closing to update…", failed: "Update failed", "can't update itself": "Can't update itself", downloading: "Downloading version 1.3.0" };
  for (const [name, label] of Object.entries(labels)) {
    s.update(name);
    await expect(page.locator(".sb-foot .upd")).toHaveAccessibleName(label);
    await same(`update ${name}`);
  }
  s.runtime("stopped");
  await expect(settings(page).locator(".fdot.amber")).toHaveCount(1);
  await same("a stopped runtime");
  s.runtime("wrong-service");
  await expect(settings(page).locator(".fdot.red")).toHaveCount(1);
  await same("a wrong service on the port");
  s.runtime();
  await expect(settings(page).locator(".fdot")).toHaveCount(0);

  await page.keyboard.press("Control+Comma");
  await expect(page.locator(".set")).toBeVisible();
  await expect(settings(page)).toHaveAttribute("aria-pressed", "true");
  await same("Settings");
});

// Guards the owner's rulings that icons beat words: the footer's words live in its tooltips.
test("the tooltips carry the words, and the Models tooltip names the model", async ({ page, open }) => {
  await desktopBridge(page);
  const s = await footerSocket(page);
  await open();
  await waitReady(page);
  await expect(settings(page)).toHaveAttribute("data-tip", "Settings · Ctrl ,");
  await expect(settings(page)).toHaveAccessibleName("Settings");
  await expect(models(page)).toHaveAttribute("data-tip", "Models");
  const update = page.locator(".sb-foot .upd");
  await expect(update).toHaveAccessibleName("Check for updates");
  await expect(update).toHaveAttribute("data-tip", /Not checked since Gates Local started/);

  s.pull(QWEN14);
  await expect(models(page)).toHaveAttribute("data-tip", /^<b>Downloading Qwen 3 14B<\/b> · 61% · 5\.3 of 8\.6 GB$/);
  await expect(models(page)).toHaveAccessibleName(/^Models · Downloading Qwen 3 14B · 61%/);
  await models(page).hover();
  await expect(page.locator("#tip.open")).toContainText("Downloading Qwen 3 14B · 61%");
  s.pull(QWEN4);
  await expect(models(page)).toHaveAttribute("data-tip", /Qwen 3 14B.*<br><b>Downloading Qwen 3\.5 4B<\/b>/);
  s.pull({ ...QWEN14, state: "error", completedBytes: 0, message: "no space left on device" });
  await expect(models(page)).toHaveAttribute("data-tip", /<b>Qwen 3 14B did not finish downloading\.<\/b> no space left on device/);

  s.update("available");
  await expect(update).toHaveAccessibleName("Update to def5678");
  await expect(update).toHaveAttribute("data-tip", /3 changes from abc1234 to def5678/);
  await expect(update.locator(".fdot.amber")).toHaveCount(1);
  s.update("failed");
  await expect(update).toHaveAccessibleName("Update failed");
  await expect(update).toHaveAttribute("data-tip", /Full log: \/srv\/updates\/failure\.log/);

  s.runtime("wrong-service");
  await expect(settings(page)).toHaveAccessibleName(/^Settings · Port \d+ · busy$/);
  await expect(settings(page)).toHaveAttribute("data-tip", /^<b>Port \d+ · busy<\/b><br>Something other than Ollama answers on port \d+\.<br>Settings · Ctrl ,$/);
  await settings(page).click();
  await expect(page.getByRole("heading", { name: "Runtime" })).toBeVisible();
});

// Guards the owner's ask for auto update: an update asks once, in the footer (unsure: the clone case may not matter to him).
test("a clone's update asks once in the footer, and Cancel puts focus back", async ({ page, open }) => {
  await desktopBridge(page);
  const s = await footerSocket(page);
  const dialogs: string[] = [];
  page.on("dialog", async (d) => {
    dialogs.push(d.message());
    await d.dismiss();
  });
  await open();
  await waitReady(page);
  s.update("available");
  const update = page.getByRole("button", { name: "Update to def5678", exact: true });
  await update.click();
  const ask = page.getByRole("group", { name: "Confirm update" });
  await expect(ask).toContainText("Update to def5678 and restart?");
  await expect(ask.locator("li")).toHaveText(["Falls back to abc1234 if a step fails."]);
  await expect(ask.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
  await expect(update).toBeFocused();
  await update.click();
  await ask.getByRole("button", { name: "Update and restart" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-update-started", "yes");
  // after the one ask, focus is on the update button, now closing to update
  await expect(page.locator(".sb-foot .upd")).toBeFocused();
  expect(dialogs, "no second, native prompt").toEqual([]);
});

// Guards the owner's ruling to show only what is true: a browser tab cannot update, so it shows no update icon.
test("in a browser tab the footer is Settings, Models and Usage, no update", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await expect(page.locator(".sb-foot button.ibtn")).toHaveCount(3);
  await expect(page.locator(".sb-foot .upd")).toHaveCount(0);
});
