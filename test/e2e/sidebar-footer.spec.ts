// The sidebar footer is one row of four icon buttons: Settings, Models, Usage and,
// in the desktop app, the update icon at the far right. Its boxes never move
// between states or between chat and Settings, it holds no words, and every
// word it has to say is in a tooltip (data-tip) and the accessible name.
import { expect, test, waitReady } from "./fixtures.ts";
import type { UpdateCheck, UpdateStatus } from "@gates-local/contracts";
import { QWEN14, QWEN4, UPDATE, desktopBridge, footerBoxes, footerSocket, footerWords } from "./footer-fixture.ts";

const settings = (page: import("@playwright/test").Page) => page.locator(".sb-foot").getByRole("button", { name: /^Settings/ });
const models = (page: import("@playwright/test").Page) => page.locator(".sb-foot").getByRole("button", { name: /^Models/ });

test("one row of four icon buttons whose boxes never move, in any state or in Settings", async ({ page, open }) => {
  await desktopBridge(page);
  const s = await footerSocket(page);
  await open();
  await waitReady(page);
  const buttons = page.locator(".sb-foot button.ibtn");
  await expect(buttons).toHaveCount(4);
  const first = await footerBoxes(page);
  // one row: every button on the same line, 32 px square, the update icon at the far right
  expect(new Set(first.buttons.map((b) => b[1])).size).toBe(1);
  for (const b of first.buttons) expect(b.slice(2)).toEqual([32, 32]);
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

test("the keyboard reaches all four buttons in order, and a busy one keeps its focus and tooltip", async ({ page, open }) => {
  await desktopBridge(page);
  const s = await footerSocket(page);
  await open();
  await waitReady(page);
  const reached: string[] = [];
  await page.locator("body").focus();
  for (let i = 0; i < 80 && reached.length < 4; i++) {
    await page.keyboard.press("Tab");
    const name = await page.evaluate(() => (document.activeElement?.closest(".sb-foot") ? document.activeElement.getAttribute("aria-label") : null));
    if (name !== null && !reached.includes(name)) reached.push(name);
  }
  expect(reached).toEqual(["Settings", "Models", "Usage", "Check for updates"]);
  await expect(page.locator("#tip.open")).toContainText("Check for updates");

  // a check in flight: the button stays focused, says so, and a second press does nothing; reduced motion stops the turning arrows
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.keyboard.press("Enter");
  const update = page.locator(".sb-foot .upd");
  await expect(update).toHaveAttribute("aria-disabled", "true");
  await expect(update).toBeFocused();
  await expect(update).toHaveAttribute("data-tip", /./);
  expect(await update.locator(".spin").evaluate((e) => getComputedStyle(e).animationName)).toBe("none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(await update.locator(".spin").evaluate((e) => getComputedStyle(e).animationName)).not.toBe("none");
  // pressed while busy: no pressed look
  await update.hover();
  await page.mouse.down();
  await page.waitForTimeout(250);
  expect(await update.evaluate((e) => getComputedStyle(e).backgroundColor), "a busy button shows no pressed look").toBe("rgba(0, 0, 0, 0)");
  await page.mouse.up();
  s.releaseCheck();
  await expect(update).not.toHaveAttribute("aria-disabled", "true");
});

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

test("the confirm closes on a click outside, on Escape from anywhere, and when the click stops being Update; it never reopens by itself", async ({ page, open }) => {
  await desktopBridge(page);
  const s = await footerSocket(page);
  await open();
  await waitReady(page);
  s.update("available");
  const update = page.locator(".sb-foot .upd");
  const ask = page.getByRole("group", { name: "Confirm update" });
  // the update has arrived before the first press, or the press checks instead
  await expect(update).toHaveAccessibleName("Update to def5678");
  await update.click();
  await expect(ask).toBeVisible();
  await page.locator("#ta").click();
  await expect(ask).toHaveCount(0);
  await expect(page.locator("#ta")).toBeFocused();

  await update.click();
  await expect(ask).toBeVisible();
  await page.locator("#ta").focus();
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);

  await update.click();
  await expect(ask).toBeVisible();
  s.update("updating");
  await expect(ask).toHaveCount(0);
  await page.locator("#ta").focus();
  s.update("available");
  await expect(update).toHaveAccessibleName("Update to def5678");
  await page.waitForTimeout(300);
  await expect(ask).toHaveCount(0);
  await expect(page.locator("#ta")).toBeFocused();
});

test("an open tooltip follows its button's words as a download moves, and closes when the words go", async ({ page, open }) => {
  const s = await footerSocket(page);
  await open();
  await waitReady(page);
  s.pull(QWEN14);
  await expect(models(page)).toHaveAttribute("data-tip", /61%/);
  await models(page).hover();
  const tip = page.locator("#tip.open");
  await expect(tip).toContainText("61%");
  const bottom = () => tip.evaluate((e) => Math.round(e.getBoundingClientRect().bottom));
  const anchored = await bottom();
  for (const [done, pct] of [[6_000_000_000, 64], [6_500_000_000, 70], [7_000_000_000, 75]] as const) {
    s.pull({ ...QWEN14, completedBytes: done });
    await expect(models(page)).toHaveAttribute("data-tip", new RegExp(` ${pct}% `));
    await expect(tip, `the tooltip stays open at ${pct}%`).toContainText(`${pct}%`);
  }
  expect(await bottom(), "the edge next to the button does not move").toBe(anchored);
  await models(page).evaluate((e) => e.removeAttribute("data-tip"));
  await expect(page.locator("#tip.open")).toHaveCount(0);
});

test("a failed check or download says why in the tooltip, and Download sends once however often it is pressed", async ({ page, open }) => {
  await desktopBridge(page);
  const s = await footerSocket(page);
  await open();
  await waitReady(page);
  const update = page.locator(".sb-foot .upd");
  await update.click();
  await expect(update).toHaveAttribute("aria-disabled", "true");
  s.failCheck("the git remote did not answer");
  await expect(update).toHaveAccessibleName("Could not check for updates");
  await expect(update).toHaveAttribute("data-tip", /Couldn't check for updates because .*the git remote did not answer/);
  await expect(update).toHaveAttribute("data-tip", /Click to check again\./);
  await update.click();
  await expect(update).toHaveAttribute("aria-disabled", "true");
  s.releaseCheck();
  await expect(update).toHaveAccessibleName("Check for updates");

  s.update("available (installed copy)");
  await expect(update).toHaveAccessibleName("Download version 1.3.0");
  const before = s.sent().filter((m) => m === "update.download").length;
  await update.click();
  await expect(update).toHaveAttribute("aria-disabled", "true");
  await update.click({ force: true });
  await update.click({ force: true });
  expect(s.sent().filter((m) => m === "update.download").length - before).toBe(1);
  s.failDownload("no space left on device");
  await expect(update).toHaveAccessibleName("Download failed");
  await expect(update).toHaveAttribute("data-tip", /no space left on device/);
  await update.click();
  await expect.poll(() => s.sent().at(-1)).toBe("update.check");
});

test("a clone that only its owner can fix says so without red, and its click opens Settings › General", async ({ page, open }) => {
  await desktopBridge(page);
  const s = await footerSocket(page);
  await open();
  await waitReady(page);
  const update = page.locator(".sb-foot .upd");
  s.update("local changes");
  await expect(update).toHaveAccessibleName("Can't update itself");
  await expect(update).toHaveAttribute("data-tip", /This copy has changes that are not committed/);
  await expect(update).not.toHaveClass(/\bred\b/);
  await update.hover();
  await expect(page.locator("#tip.open")).toContainText("not committed");
  await page.screenshot({ path: test.info().outputPath("footer-local-changes.png"), animations: "disabled", caret: "hide" });
  await update.click();
  await expect(page.locator(".set .set-h h1")).toHaveText("General");
  s.update("could not reach the remote");
  await expect(update).toHaveAccessibleName("Could not check for updates");
  await expect(update).toHaveClass(/\bred\b/);
});

test("a shown result is dismissed by the click that acts on it; a failed rollback opens Settings", async ({ page, open }) => {
  await desktopBridge(page);
  const s = await footerSocket(page);
  await open();
  await waitReady(page);
  const update = page.locator(".sb-foot .upd");
  s.update("failed");
  await expect(update).toHaveAccessibleName("Update failed");
  await update.click();
  await expect.poll(() => s.sent()).toEqual(expect.arrayContaining(["update.dismissResult", "update.check"]));
  s.releaseCheck();
  await expect(update).toHaveAccessibleName("Check for updates");
  s.update("rollback failed");
  await expect(update).toHaveAccessibleName("Update failed");
  await expect(update).toHaveAttribute("data-tip", /Click to open Settings/);
  await update.click();
  await expect(page.locator(".set .set-h h1")).toHaveText("General");
  expect(s.sent().filter((m) => m === "update.dismissResult")).toHaveLength(1);
});

test("good news clears a footer error: a check that answered elsewhere, a download that runs, a background check after a failed install", async ({ page, open }) => {
  await desktopBridge(page);
  const s = await footerSocket(page);
  await open();
  await waitReady(page);
  const update = page.locator(".sb-foot .upd");
  await update.click();
  s.failCheck("the git remote did not answer");
  await expect(update).toHaveAccessibleName("Could not check for updates");
  // the hourly check, Settings or another window answered
  s.update("available");
  await expect(update).toHaveAccessibleName("Update to def5678");
  await expect(update.locator(".fdot.amber")).toHaveCount(1);
  await expect(update).not.toHaveClass(/\bred\b/);

  s.update("available (installed copy)");
  await update.click();
  s.failDownload("no space left on device");
  await expect(update).toHaveAccessibleName("Download failed");
  s.update("downloading");
  await expect(update).toHaveAccessibleName("Downloading version 1.3.0");
  await expect(update.locator(".ring")).toHaveCount(1);

  // an install that could not start, then a background check; the download error that good news cleared does not come back
  s.update("available");
  await expect(update).toHaveAccessibleName("Update to def5678");
  s.blockPrepare("A model download started; check again.");
  await update.click();
  const ask = page.getByRole("group", { name: "Confirm update" });
  await ask.getByRole("button", { name: "Update and restart" }).click();
  await expect(update).toHaveAccessibleName("Update failed");
  await expect(update).toHaveAttribute("data-tip", /A model download started/);
  const available = UPDATE["available"] as UpdateStatus;
  s.push({ ...available, lastCheck: { ...(available.lastCheck as Extract<UpdateCheck, { state: "available" }>), checkedAt: 2 } });
  await expect(update).toHaveAccessibleName("Update to def5678");
});

test("a shown result with a fresh target: the click opens the ask and keeps the note, Go dismisses it", async ({ page, open }) => {
  await desktopBridge(page);
  const s = await footerSocket(page);
  await open();
  await waitReady(page);
  const update = page.locator(".sb-foot .upd");
  s.update("failed, a fresh target");
  await expect(update).toHaveAccessibleName("Update failed");
  await update.click();
  const ask = page.getByRole("group", { name: "Confirm update" });
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(update).toHaveAccessibleName("Update failed");
  expect(s.sent()).not.toContain("update.dismissResult");
  await update.click();
  await ask.getByRole("button", { name: "Update and restart" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-update-started", "yes");
  expect(s.sent()).toContain("update.dismissResult");
});

test("the ask reads this window's work again at Go: new words, marked, a wait, nothing installed; a read that failed keeps Go off", async ({ page, open }) => {
  await desktopBridge(page);
  const s = await footerSocket(page);
  await open();
  await waitReady(page);
  const update = page.locator(".sb-foot .upd");
  s.update("available");
  await expect(update).toHaveAccessibleName("Update to def5678");
  await update.click();
  const ask = page.getByRole("group", { name: "Confirm update" });
  const go = ask.getByRole("button", { name: "Update and restart" });
  await expect(go).toBeEnabled();
  await expect(ask.locator("li")).toHaveText(["Falls back to abc1234 if a step fails."]);
  // typed without a pointer, so the ask stays open: an unsent draft in this window
  await page.locator("#ta").focus();
  await page.keyboard.type("half a thought");
  await go.focus();
  await page.keyboard.press("Enter");
  await expect(ask.locator("li").first()).toHaveText("1 unsent draft is kept.");
  await expect(ask.getByRole("status")).toContainText("Changed");
  await expect(go).toBeDisabled();
  await expect(ask.getByRole("button", { name: "Cancel" }), "focus never drops to the page").toBeFocused();
  const during = await ask.evaluate((e) => e.getBoundingClientRect().height);
  await expect(page.locator("html")).not.toHaveAttribute("data-update-started", "yes");
  await expect(go).toBeEnabled({ timeout: 3000 });
  expect(await ask.evaluate((e) => e.getBoundingClientRect().height), "the mark does not change the height").toBe(during);
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
  await expect(update).toBeFocused();

  s.failStatus("Gates Local refused it (busy)");
  await update.click();
  await expect(ask.getByRole("alert")).toContainText("busy");
  await page.waitForTimeout(300);
  await expect(go).toBeDisabled();
});

test("Escape closes what is on top first: a picker, then a tooltip, then the ask", async ({ page, open }) => {
  await desktopBridge(page);
  const s = await footerSocket(page);
  await open();
  await waitReady(page);
  const update = page.locator(".sb-foot .upd");
  s.update("available");
  await expect(update).toHaveAccessibleName("Update to def5678");
  await update.click();
  const ask = page.getByRole("group", { name: "Confirm update" });
  await expect(ask).toBeVisible();
  await page.keyboard.press("Control+m");
  await expect(page.locator("#picker")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#picker")).toHaveCount(0);
  await expect(ask).toBeVisible();
  await page.locator(".sb-foot").getByRole("button", { name: /^Models/ }).hover();
  await expect(page.locator("#tip.open")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator("#tip.open")).toHaveCount(0);
  await expect(ask).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
});

test("in a browser tab the footer is Settings, Models and Usage, no update", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await expect(page.locator(".sb-foot button.ibtn")).toHaveCount(3);
  await expect(page.locator(".sb-foot .upd")).toHaveCount(0);
});

for (const width of [390, 320]) test(`in the phone drawer at ${width}px the buttons are 44 px and stay on one row`, async ({ page, open }) => {
  await page.setViewportSize({ width, height: 800 });
  await open();
  await waitReady(page);
  await page.getByRole("button", { name: "Open threads" }).click();
  await expect(page.locator(".sb-foot")).toBeInViewport({ ratio: 1 });
  const boxes = await footerBoxes(page);
  expect(boxes.buttons).toHaveLength(3);
  for (const b of boxes.buttons) expect(b.slice(2)).toEqual([44, 44]);
  expect(new Set(boxes.buttons.map((b) => b[1])).size).toBe(1);
  expect(await page.locator(".sb-foot").evaluate((f) => f.scrollWidth <= f.clientWidth)).toBe(true);
  expect(await footerWords(page)).toEqual([]);
});

test("a narrow desktop window at 320px: four 44 px buttons in the drawer, the update icon at the right edge, nothing clipped; closing the drawer closes the confirm", async ({ page, open }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await desktopBridge(page);
  const s = await footerSocket(page);
  await open();
  await waitReady(page);
  await page.getByRole("button", { name: "Open threads" }).click();
  await expect(page.locator(".sb-foot")).toBeInViewport({ ratio: 1 });
  const boxes = await footerBoxes(page);
  expect(boxes.buttons).toHaveLength(4);
  for (const b of boxes.buttons) expect(b.slice(2)).toEqual([44, 44]);
  expect(new Set(boxes.buttons.map((b) => b[1])).size).toBe(1);
  const [fx, , fw] = boxes.foot as [number, number, number, number];
  const last = boxes.buttons[3] as [number, number, number, number];
  expect(fx + fw - (last[0] + last[2])).toBeLessThanOrEqual(9);
  expect(last[0] + last[2]).toBeLessThanOrEqual(320);
  expect(await page.locator(".sb-foot").evaluate((f) => f.scrollWidth <= f.clientWidth)).toBe(true);
  console.log(`NARROW320 ${JSON.stringify(boxes)}`);

  s.update("available");
  await expect(page.locator(".sb-foot .upd"), "the pushed update is shown; a click before it checks instead").toHaveAccessibleName("Update to def5678");
  await page.locator(".sb-foot .upd").click();
  const ask = page.getByRole("group", { name: "Confirm update" });
  await expect(ask).toBeVisible();
  expect(await ask.evaluate((e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0; }), "the confirm fits the window").toBe(true);
  await page.goBack();
  await expect(page.locator(".sb-foot")).not.toBeInViewport();
  await expect(ask).toHaveCount(0);
});
