// UI probe only: the existing updater has separate real-clone runtime acceptance.
// Run through the virtual-screen runner, never on the implementation host.
import type { UpdateCheck, UpdateStatus } from "@gates-local/contracts";
import type { Page, WebSocketRoute } from "@playwright/test";
import { test, expect, sendMessage, stack, waitReady } from "./fixtures.ts";
import { updateFixtureState } from "./update-fixture.ts";

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

// Guards a shipped bug fix: a successful update showed a note; it stays silent, and a failure notice dismisses without a shift.
test("AV-05 success stays silent; failure spans the Settings top and dismisses without a width shift", async ({ page, open }) => {
  const update = await updates(page, true, true);
  await open(); await waitReady(page);
  await expect(page.locator(".sb-foot .upd")).toHaveAccessibleName("Check for updates");
  await expect(page.locator(".upd-note")).toHaveCount(0);
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
  await expect(page.getByTestId("ui.update-note.dismiss")).toHaveCount(0);
  expect(await geometry(), "AV-05 successful update changed Settings width").toEqual(before);
  update.failure();
  const notice = page.getByRole("alert").filter({ hasText: "The update did not finish" });
  await expect(notice).toBeVisible();
  await notice.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
  expect(await geometry(), "AV-05 notice changed Settings width").toEqual(before);
  const bannerBox = await notice.boundingBox();
  const contentBox = await page.locator(".set-in").boundingBox();
  if (!bannerBox || !contentBox) throw new Error("No Settings notice geometry");
  expect(bannerBox.y + bannerBox.height).toBeLessThanOrEqual(contentBox.y);
  await notice.getByTestId("ui.update-note.dismiss").click();
  await expect(notice).toHaveCount(0);
  expect(await geometry(), "AV-05 dismissing changed Settings width").toEqual(before);
});

// Guards the owner's ruling on auto update: the footer's update icon turns to Update in place, moving nothing.
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
  await expect(button).toHaveAttribute("data-tip", "Update to def5678");
  const after = await Promise.all(selectors.map((s) => page.locator(s).boundingBox()));
  expect(before.every((box) => box !== null)).toBe(true);
  expect(after).toEqual(before);
  // Nothing running: one click restarts, no ask (decision 23).
  await button.click();
  await expect(page.locator("html")).toHaveAttribute("data-update-started", "yes");
  await expect(page.getByRole("group", { name: "Confirm update" })).toHaveCount(0);
  await expect(page.locator(".sb-foot .upd")).toBeDisabled();
});

// Guards the owner's ruling on auto update: one ask that names what stops (unsure: the wording came from a council row).
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
  await expect(ask.locator("li")).toHaveText(["1 reply stops. Its text is kept."]);
  await expect(ask).toContainText("Update to def5678 and restart?");
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(ask).toHaveCount(0);
  await expect(page.locator(".writing")).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-update-started", "yes");
  await button.click();
  await ask.getByTestId("sidebar.update.go").click();
  await expect(page.locator("html")).toHaveAttribute("data-update-started", "yes");
  expect(dialogs, "one ask: no native prompt after the panel").toEqual([]);
});

const upToDate = (current: string, channel: "main" | "release", checkedAt: number): UpdateCheck => ({ state: "up-to-date", checkedAt, channel, current });

test.describe("Version with the update state, then the automatic switch", () => {
  test.use({ colorScheme: "dark" });
  const CHECKED = Date.UTC(2026, 10, 13, 6, 57);
  interface Copy { readonly name: string; readonly idle: UpdateStatus; readonly said: string; readonly found: UpdateCheck; readonly failed: UpdateCheck & { state: "cannot-check" } }
  const copies: readonly Copy[] = [
    {
      name: "clone",
      idle: { version: { kind: "commit", commit: "7093c45", date: Date.UTC(2026, 10, 12, 18) }, result: null, lastCheck: null, activity: [] },
      said: "7093c45",
      found: { state: "available", checkedAt: CHECKED, channel: "release", current: "7093c45", target: "def5678", total: 25, changes: ["Faster chat", "A new setting", "Fewer words in Settings", "Two", "One"] },
      failed: { state: "cannot-check", checkedAt: CHECKED, reason: "error", lines: ["The check stopped on an error: git fetch exited with code 128", "Try again, or run pnpm run app-update --check in the Gates Local folder to see more."] },
    },
    {
      name: "installed",
      idle: { version: { kind: "installed", version: "0.2.1" }, result: null, lastCheck: null, activity: [] },
      said: "0.2.1",
      found: { state: "newer", checkedAt: CHECKED, current: "0.2.1", target: "0.2.2", forThisCopy: true, lines: ["Downloading version 0.2.2 (12 of 98 MB). You can keep chatting."], page: "https://example.invalid/releases/latest", download: "downloading" },
      failed: { state: "cannot-check", checkedAt: CHECKED, reason: "unreachable", lines: ["Could not reach the update server. Check your connection."] },
    },
  ];
  // Guards the owner's ruling on the Updates card (decision 25): one row for the version and its state, and the card never changes size.
  for (const copy of copies) test(`${copy.name}: one row for the version and its state; the card keeps its size through checking, up to date, found and failed`, async ({ page, open }) => {
    let lastCheck: UpdateCheck | null = null;
    let answer: ((next: UpdateCheck) => void) | undefined;
    await page.routeWebSocket(/\/\?token=/, (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw)) as { method?: string; id: string };
        const reply = (result: unknown) => socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result }));
        if (message.method === "update.status") reply({ ...copy.idle, lastCheck, canControl: true });
        // The check waits for the test, so the card can be measured while it runs.
        else if (message.method === "update.check") answer = (next) => { lastCheck = next; reply(next); };
        else {
          server.send(raw);
          // As the server does (update/module.ts): flipping Get every change drops the last check and says so.
          const params = (message as { params?: { updateEveryChange?: boolean } }).params;
          if (message.method === "settings.update" && params?.updateEveryChange !== undefined && lastCheck !== null) {
            lastCheck = null;
            socket.send(JSON.stringify({ type: "push", channel: "update.changed", payload: { ...copy.idle, lastCheck, canControl: true } }));
          }
        }
      });
    });
    await open(); await waitReady(page);
    await page.keyboard.press("Control+Comma");
    await expect(page.locator(".set .set-h h1")).toHaveText("General");
    const group = page.locator(".grp").filter({ has: page.locator(".grp-t", { hasText: /^Updates$/ }) });
    const card = group.locator(".box");
    await expect(card).toContainText(copy.said);
    // The card, and each row above the automatic-check switches: what the version and the check take up.
    const measure = () => card.evaluate((box) => {
      const r = box.getBoundingClientRect();
      const above: HTMLElement[] = [];
      for (const child of Array.from(box.children) as HTMLElement[]) {
        if (child.querySelector("[role=switch]") !== null) break;
        above.push(child);
      }
      return {
        card: [r.x, r.y, r.width, r.height],
        rows: above.map((el) => { const b = el.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; }),
        text: above.map((el) => el.innerText.split("\n").join(" / ")),
      };
    });
    const start = await measure();
    const moves: string[] = [];
    const same = (step: string, now: Awaited<ReturnType<typeof measure>>) => {
      if (JSON.stringify([now.card, now.rows]) !== JSON.stringify([start.card, start.rows])) moves.push(`${step}: card ${JSON.stringify(start.card)} -> ${JSON.stringify(now.card)}, rows ${start.rows.length} -> ${now.rows.length} (${now.text.join(" | ")})`);
    };
    // The one control on the state's row: its first button, whatever its words.
    const control = group.locator(".srow").filter({ has: page.locator("button.btn") }).first().locator("button.btn");
    const steps: readonly (readonly [string, UpdateCheck, string])[] = [
      ["up to date", upToDate(copy.said, "release", CHECKED), "Up to date"],
      ["found", copy.found, copy.found.state === "available" || copy.found.state === "newer" ? copy.found.target : ""],
      ["failed", copy.failed, copy.failed.lines[0] ?? ""],
      ["up to date again", upToDate(copy.said, "release", CHECKED + 60_000), "Up to date"],
    ];
    for (const [step, next, words] of steps) {
      await control.click();
      await expect(control).toBeDisabled();
      same(`checking before ${step}`, await measure());
      answer?.(next);
      await expect(card).toContainText(words);
      await expect(control).toBeEnabled();
      same(step, await measure());
      if (step === "up to date") {
        const text = (await measure()).text.join("\n");
        expect(start.rows.length, `rows above the switches: ${start.text.join(" | ")}`).toBe(1);
        expect(text.split(copy.said).length - 1, `"${copy.said}" said ${text.split(copy.said).length - 1} times: ${text}`).toBe(1);
        expect(text).not.toContain("Asks this copy's git remote");
        if (copy.name === "clone") {
          // UR-01, row 9: the switch now follows every change, so the server drops the release check; row 1 waits for a check, in the same space.
          // The switch is in the clone's fold, which closes again before the card is measured.
          const more = group.getByTestId("settings.updates.more");
          await expect(more).toHaveAttribute("aria-expanded", "false");
          await more.click();
          const every = group.getByTestId("settings.updates.every-change");
          const line = group.locator(".srow").first().locator(".src-help");
          await every.click();
          await expect(every).toHaveAttribute("aria-checked", "true");
          await expect(line).toHaveText("Not checked yet.");
          await expect(control).toHaveText("Check for updates");
          await expect(control).toBeEnabled();
          await every.click();
          await expect(every).toHaveAttribute("aria-checked", "false");
          // Dropped, not kept for a flip back: the next check answers.
          await expect(line).toHaveText("Not checked yet.");
          await more.click();
          await expect(every).toHaveCount(0);
          same("every change switched on and off again", await measure());
        }
      }
    }
    expect(moves, "the card or a row changed size or place").toEqual([]);
  });

  // Guards the owner's ruling on the Updates card: the release page link sits beside the control, the card keeps its size.
  test("UR-03 at 390px the release page link shows beside the control without growing the card", async ({ page, open }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const PAGE = "https://example.invalid/releases/latest";
    const idle: UpdateStatus = { version: { kind: "installed", version: "0.2.1" }, result: null, lastCheck: null, activity: [] };
    let lastCheck: UpdateCheck | null = null;
    let answer: ((next: UpdateCheck) => void) | undefined;
    await page.routeWebSocket(/\/\?token=/, (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw)) as { method?: string; id: string };
        const reply = (result: unknown) => socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result }));
        if (message.method === "update.status") reply({ ...idle, lastCheck, canControl: true });
        else if (message.method === "update.check") answer = (next) => { lastCheck = next; reply(next); };
        else server.send(raw);
      });
    });
    await open(); await waitReady(page);
    await page.keyboard.press("Control+Comma");
    await expect(page.locator(".set")).toBeVisible();
    // The settings section may start on the phone section list.
    const general = page.getByTestId("settings.sections.open-general");
    if (await general.isVisible()) await general.click();
    const group = page.locator(".grp").filter({ has: page.locator(".grp-t", { hasText: /^Updates$/ }) });
    const card = group.locator(".box");
    await expect(card).toContainText("0.2.1");
    await group.scrollIntoViewIfNeeded();
    const height = () => card.evaluate((box) => box.getBoundingClientRect().height);
    const control = group.locator(".srow").first().locator("button.btn");
    const link = group.getByTestId("settings.updates.release-page");
    const start = await height();
    const heights: string[] = [];
    const steps: readonly (readonly [string, UpdateCheck, boolean])[] = [
      ["up to date", upToDate("0.2.1", "release", Date.UTC(2026, 10, 13, 6, 57)), false],
      ["not for this copy", { state: "newer", checkedAt: Date.UTC(2026, 10, 13, 7, 0), current: "0.2.1", target: "0.2.2", forThisCopy: false, lines: ["Version 0.2.2 is available, but this copy cannot install it by itself. Download it from the release page."], page: PAGE }, true],
      ["bad signature", { state: "cannot-check", checkedAt: Date.UTC(2026, 10, 13, 7, 1), reason: "bad-signature", lines: ["The release list did not pass its signature check, so Gates Local ignored it."], page: PAGE }, true],
      ["up to date again", upToDate("0.2.1", "release", Date.UTC(2026, 10, 13, 7, 2)), false],
    ];
    for (const [step, next, linked] of steps) {
      await control.click();
      answer?.(next);
      await expect(link).toHaveCount(linked ? 1 : 0);
      await expect(control).toBeEnabled();
      if (linked) {
        await expect(link).toBeVisible();
        // The link and the control share one line.
        const [l, c] = [await link.boundingBox(), await control.boundingBox()];
        expect.soft(l !== null && c !== null && Math.abs((l.y + l.height / 2) - (c.y + c.height / 2)) < 2, `${step}: link ${JSON.stringify(l)} and control ${JSON.stringify(c)} on one line`).toBe(true);
      }
      const now = await height();
      if (now !== start) heights.push(`${step}: ${start} -> ${now}`);
    }
    expect(heights, "the card's height changed at 390px").toEqual([]);
  });

  // Guards the owner's ruling (updates row 9): a clone with no release tags is still offered its update.
  test("row 9 a clone with no release tags and the switch off is offered the update its check found", async ({ page, open }) => {
    await page.addInitScript(() => {
      Object.assign(window, { gatesLocal: { updateApprovalVersion: 2, getServerUrl: async () => new URLSearchParams(location.search).get("server"), onState: () => () => undefined, updateAndRestart: async () => ({ ok: true }) } });
    });
    const idle: UpdateStatus = { version: { kind: "commit", commit: "7093c45", date: Date.UTC(2026, 10, 12, 18) }, result: null, lastCheck: null, activity: [] };
    // With no release tags the server checks main even with the switch off (update/check.ts, choice auto).
    const found: UpdateCheck = { state: "available", checkedAt: Date.UTC(2026, 10, 13, 6, 57), channel: "main", current: "7093c45", target: "def5678", targetCommit: `def5678${"0".repeat(33)}`, total: 2, changes: ["Faster chat", "A new setting"] };
    let lastCheck: UpdateCheck | null = null;
    await page.routeWebSocket(/\/\?token=/, (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw)) as { method?: string; id: string };
        const reply = (result: unknown) => socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result }));
        if (message.method === "update.status") reply({ ...idle, lastCheck, canControl: true });
        else if (message.method === "update.check") { lastCheck = found; reply(found); }
        else server.send(raw);
      });
    });
    await open(); await waitReady(page);
    await page.keyboard.press("Control+Comma");
    await expect(page.locator(".set .set-h h1")).toHaveText("General");
    const group = page.locator(".grp").filter({ has: page.locator(".grp-t", { hasText: /^Updates$/ }) });
    await group.getByTestId("settings.updates.more").click();
    await expect(group.getByTestId("settings.updates.every-change")).toHaveAttribute("aria-checked", "false");
    await group.getByTestId("settings.updates.check").click();
    await expect(group.locator(".srow").first().locator(".src-help")).toHaveText("Update def5678: 2 changes.");
    await expect(group.getByTestId("settings.updates.update")).toBeVisible();
    await group.evaluate((el) => { el.style.outline = "3px solid #e5484d"; el.style.outlineOffset = "-3px"; });
    await group.screenshot({ path: test.info().outputPath("update-row9-no-tags-switch-off.png") });
  });

  // Updates row 2 (Windows W-A): the downloaded, checked installer is offered as Restart to update, not a second download.
  // Before that, a copy that cannot install it says so whole, never cut off (decision 24).
  // The platform is faked: the server's Windows lines are replayed into the web client; the click itself is unit-tested (windows.test.ts).
  test("row 2 a Windows install with the checked installer on disk offers Restart to update in the same row", async ({ page, open }) => {
    await page.addInitScript(() => {
      Object.assign(window, { gatesLocal: { updateApprovalVersion: 2, getServerUrl: async () => new URLSearchParams(location.search).get("server"), onState: () => () => undefined, updateAndRestart: async () => ({ ok: true }) } });
    });
    const PAGE = "https://example.invalid/releases/tag/v0.2.2";
    const ready = { state: "newer", checkedAt: Date.UTC(2026, 10, 13, 7, 0), current: "0.2.1", target: "0.2.2", forThisCopy: true, page: PAGE, download: "ready" } as const;
    // What a copy that cannot install it says, and what a copy that can says for the same download.
    const before: UpdateCheck = { ...ready, lines: ["Update 0.2.2 is downloaded and checked. Run this installer to update."] };
    const after: UpdateCheck = { ...ready, restart: true, lines: ["Version 0.2.2 is downloaded and checked.", "If version 0.2.2 does not start, Gates Local will not go back by itself. To go back, download version 0.2.1 from https://example.invalid/releases/tag/v0.2.1."] };
    const idle: UpdateStatus = { version: { kind: "installed", version: "0.2.1" }, result: null, lastCheck: before, activity: [] };
    let route: WebSocketRoute | undefined;
    await page.routeWebSocket(/\/\?token=/, (socket) => {
      route = socket;
      const server = socket.connectToServer();
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw)) as { method?: string; id: string };
        if (message.method === "update.status") socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: { ...idle, canControl: true } }));
        else server.send(raw);
      });
    });
    await open(); await waitReady(page);
    await page.keyboard.press("Control+Comma");
    await expect(page.locator(".set .set-h h1")).toHaveText("General");
    const group = page.locator(".grp").filter({ has: page.locator(".grp-t", { hasText: /^Updates$/ }) });
    const row = group.locator(".srow").first();
    const line = row.locator(".src-help");
    await expect(line).toHaveText("Update 0.2.2 is downloaded and checked. Run this installer to update.");
    // Said whole: nothing of the line is cut off.
    expect(await line.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(group.getByRole("button", { name: "Restart to update", exact: true })).toHaveCount(0);
    await group.scrollIntoViewIfNeeded();
    await group.screenshot({ path: test.info().outputPath("update-windows-row2-before.png") });
    route?.send(JSON.stringify({ type: "push", channel: "update.changed", payload: { ...idle, lastCheck: after, approval: "approval-1", canControl: true } }));
    const restart = group.getByRole("button", { name: "Restart to update", exact: true });
    await expect(restart).toBeVisible();
    await expect(line).toHaveText("Update 0.2.2 downloaded and checked.");
    await expect(row).not.toContainText("download it from the release page");
    await expect(group.locator(".tipped")).toHaveCount(0);
    await group.screenshot({ path: test.info().outputPath("update-windows-row2-after.png") });
  });

  // Guards the owner's ruling (updates row 10): a listener's row keeps its height. The release page is not offered there (decision 19: no tips).
  test("row 10 at 390px a listener's row keeps its height and offers no control", async ({ page, open }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const idle: UpdateStatus = { version: { kind: "installed", version: "0.2.1" }, result: null, lastCheck: upToDate("0.2.1", "release", Date.UTC(2026, 10, 13, 6, 57)), activity: [] };
    const newer: UpdateCheck = { state: "newer", checkedAt: Date.UTC(2026, 10, 13, 7, 0), current: "0.2.1", target: "0.2.2", forThisCopy: false, lines: ["Version 0.2.2 is available, but this copy cannot install it by itself. Download it from the release page."], page: "https://example.invalid/releases/latest" };
    let route: WebSocketRoute | undefined;
    await page.routeWebSocket(/\/\?token=/, (socket) => {
      route = socket;
      const server = socket.connectToServer();
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw)) as { method?: string; id: string };
        if (message.method === "update.status") socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: { ...idle, canControl: false } }));
        else server.send(raw);
      });
    });
    await open(); await waitReady(page);
    await page.keyboard.press("Control+Comma");
    await expect(page.locator(".set")).toBeVisible();
    // The settings section may start on the phone section list.
    const general = page.getByTestId("settings.sections.open-general");
    if (await general.isVisible()) await general.click();
    const group = page.locator(".grp").filter({ has: page.locator(".grp-t", { hasText: /^Updates$/ }) });
    const row = group.locator(".srow").first();
    await expect(row.locator(".src-help")).toHaveText(/^Up to date\./);
    await group.scrollIntoViewIfNeeded();
    await group.evaluate((el) => { el.style.outline = "3px solid #e5484d"; el.style.outlineOffset = "-3px"; });
    const height = () => row.evaluate((el) => el.getBoundingClientRect().height);
    const before = await height();
    route?.send(JSON.stringify({ type: "push", channel: "update.changed", payload: { ...idle, lastCheck: newer, canControl: false } }));
    await expect(row.locator(".src-help")).toHaveText("Update 0.2.2 is not built for this copy.");
    await expect(group.getByTestId("settings.updates.release-page")).toHaveCount(0);
    await expect(group.locator(".tipped")).toHaveCount(0);
    expect(await height(), "the listener's state row changed height at 390px").toBe(before);
    await group.screenshot({ path: test.info().outputPath("update-row10-listener-390.png") });
  });
});
