// The footer's state sheet: every state the three icons can show, read off the
// live footer one at a time, laid out at real size and at 4x in the dark
// theme, one screenshot. Then the footer in place: chat, Settings, a download
// running, the runtime down, the phone drawer. Screenshots only; the
// behaviour is asserted in sidebar-footer.spec.ts.
import type { Page } from "@playwright/test";
import { expect, test, waitReady } from "./fixtures.ts";
import { QWEN14, QWEN4, desktopBridge, footerSocket } from "./footer-fixture.ts";

interface Shot {
  readonly group: string;
  readonly name: string;
  /** Which button the 4x copy shows: 0 Settings, 1 Models, 2 update. */
  readonly index: number;
  readonly html: string;
}

async function dark(page: Page): Promise<void> {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
}

/** Each button's look in one string: its name, classes, dots and ring. */
const looks = (page: Page) =>
  page.locator(".sb-foot button.ibtn:not(.usage)").evaluateAll((bs) => bs.map((b) => `${b.getAttribute("aria-label")}|${b.className}|${b.querySelectorAll(".fdot").length}|${b.querySelectorAll(".ring").length}`));

/** The footer as it is now, without pointer or focus on it and without an open confirm. Every row shows one button's state; the other two must be at rest. */
async function grab(page: Page, shots: Shot[], group: string, name: string, index: number): Promise<void> {
  await page.mouse.move(600, 400);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const now = await looks(page);
  rest ??= now;
  for (const i of [0, 1, 2]) if (i !== index) expect(now[i], `${group} · ${name}: button ${i} is not at rest`).toBe(rest[i]);
  const html = await page.locator(".sb-foot").evaluate((f) => {
    const c = f.cloneNode(true) as HTMLElement;
    c.querySelector(".cfm")?.remove();
    return c.outerHTML;
  });
  shots.push({ group, name, index, html });
}
let rest: string[] | undefined;

// Usage has one look and is left out: the indices stay Settings, Models, update
const label = (page: Page, i: number) => page.locator(".sb-foot button.ibtn:not(.usage)").nth(i);

test("state sheet: every footer state at real size and 4x, dark", async ({ page, open }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await desktopBridge(page);
  const s = await footerSocket(page);
  await open();
  await waitReady(page);
  await dark(page);
  const shots: Shot[] = [];
  rest = undefined;

  await grab(page, shots, "Settings", "ready", 0);
  s.runtime("stopped");
  await expect(label(page, 0)).toHaveAccessibleName(/^Settings · /);
  await grab(page, shots, "Settings", "runtime stopped (amber)", 0);
  s.runtime("wrong-service");
  await expect(label(page, 0)).toHaveAccessibleName(/· busy$/);
  await grab(page, shots, "Settings", "wrong service on the port (red)", 0);
  s.runtime();
  await expect(label(page, 0)).toHaveAccessibleName("Settings");

  await grab(page, shots, "Models", "idle", 1);
  s.pull({ name: "qwen3:14b", state: "queued", completedBytes: 0 });
  await expect(label(page, 1)).toHaveAccessibleName(/waiting to download/);
  await grab(page, shots, "Models", "queued (turning arc)", 1);
  s.pull({ name: "qwen3:14b", state: "downloading", completedBytes: 0 });
  await expect(label(page, 1)).toHaveAccessibleName(/Starting the download/);
  await grab(page, shots, "Models", "starting, no size yet", 1);
  s.pull(QWEN14);
  await expect(label(page, 1)).toHaveAccessibleName(/61%/);
  await grab(page, shots, "Models", "downloading 61%", 1);
  s.pull(QWEN4);
  await expect(label(page, 1)).toHaveAccessibleName(/Qwen 3\.5 4B/);
  await grab(page, shots, "Models", "two downloads (total)", 1);
  s.pull({ ...QWEN4, state: "verifying", completedBytes: QWEN4.totalBytes ?? 0 });
  s.pull({ ...QWEN14, state: "cancelled" });
  await expect(label(page, 1)).toHaveAccessibleName(/Checking Qwen 3\.5 4B/);
  await grab(page, shots, "Models", "verifying", 1);
  s.pull({ ...QWEN14, state: "downloading" });
  s.pull({ ...QWEN4, state: "error", completedBytes: 0, message: "no space left on device" });
  await expect(label(page, 1)).toHaveAccessibleName(/did not finish/);
  await grab(page, shots, "Models", "failure beside a download", 1);
  s.pull({ ...QWEN14, state: "cancelled" });
  await expect(label(page, 1)).not.toHaveAccessibleName(/Downloading/);
  await grab(page, shots, "Models", "download failed", 1);
  s.pull({ ...QWEN4, state: "cancelled" });
  await expect(label(page, 1)).toHaveAccessibleName("Models");

  await grab(page, shots, "Update", "idle", 2);
  await label(page, 2).click();
  await expect(label(page, 2)).toHaveAttribute("aria-disabled", "true");
  await grab(page, shots, "Update", "checking", 2);
  s.releaseCheck();
  await expect(label(page, 2)).not.toHaveAttribute("aria-disabled", "true");
  for (const [name, title] of [
    ["available", "available (clone)"],
    ["available (installed copy)", "available (installed copy)"],
    ["downloading", "downloading (turning arc)"],
    ["updating", "updating"],
    ["failed", "failed"],
    ["download failed", "download failed (installed copy)"],
    ["can't update itself", "can't update itself, newer known"],
    ["not a clone", "can't update itself (not a clone)"],
    ["local changes", "can't update itself (local changes)"],
    ["could not reach the remote", "could not check (remote)"],
    ["rollback failed", "rollback failed (opens Settings)"],
  ] as const) {
    s.update(name);
    await expect(label(page, 2)).toHaveAttribute("data-tip", /./);
    await page.waitForTimeout(100);
    await grab(page, shots, "Update", title, 2);
  }
  s.update("idle");
  await label(page, 2).click();
  s.failCheck("the git remote did not answer");
  await expect(label(page, 2)).toHaveAccessibleName("Could not check for updates");
  await grab(page, shots, "Update", "check failed (from the footer)", 2);
  await label(page, 2).click();
  s.releaseCheck();
  await expect(label(page, 2)).toHaveAccessibleName("Check for updates");
  // No copy reaches "ready" yet (update-state.ts canRestart): built from the idle button with the ready look, green and a green dot.
  const idle = shots.find((x) => x.group === "Update" && x.name === "idle");
  if (idle === undefined) throw new Error("no idle update shot");
  shots.push({ group: "Update", name: "ready (look only, unreachable)", index: 2, html: idle.html.replace('class="ibtn upd"', 'class="ibtn green upd"').replace(/(<\/svg>)(<\/button><\/span>)/, '$1<span class="fdot green"></span>$2') });

  await page.keyboard.press("Control+Comma");
  await expect(label(page, 0)).toHaveAttribute("aria-pressed", "true");
  await grab(page, shots, "Settings", "in Settings (selected)", 0);

  const bg = await page.locator(".sb").evaluate((e) => getComputedStyle(e).backgroundColor);
  await page.setViewportSize({ width: 1240, height: 1900 });
  await page.evaluate(
    ({ list, back }) => {
      const sheet = document.createElement("div");
      sheet.id = "footer-sheet";
      sheet.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:var(--background);color:var(--foreground);padding:16px;display:grid;grid-template-columns:repeat(2,max-content);gap:6px 32px;align-content:start;font:12px/1.3 system-ui,sans-serif";
      for (const x of list) {
        const row = document.createElement("div");
        row.style.cssText = "display:grid;grid-template-columns:150px 248px 136px;align-items:center;gap:12px";
        const name = document.createElement("div");
        name.textContent = `${x.group} · ${x.name}`;
        const one = document.createElement("div");
        one.style.cssText = `width:248px;background:${back}`;
        one.innerHTML = x.html;
        const big = document.createElement("div");
        big.className = "sb-foot";
        big.style.cssText = `zoom:4;padding:0;border:0;width:max-content;background:${back}`;
        const b = one.querySelectorAll("button.ibtn:not(.usage)")[x.index];
        if (b) big.append(b.cloneNode(true));
        row.append(name, one, big);
        sheet.append(row);
      }
      document.body.append(sheet);
    },
    { list: shots, back: bg },
  );
  await page.locator("#footer-sheet").screenshot({ path: test.info().outputPath("footer-state-sheet.png"), animations: "disabled" });
});

test("in place: chat, Settings, a download running, the runtime down", async ({ page, open }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await desktopBridge(page);
  const s = await footerSocket(page);
  await open();
  await waitReady(page);
  await dark(page);
  const shot = (name: string) => page.screenshot({ path: test.info().outputPath(`footer-${name}.png`), animations: "disabled", caret: "hide" });
  await shot("chat");
  s.pull(QWEN14);
  const m = page.locator(".sb-foot button.ibtn").nth(1);
  await m.hover();
  await expect(page.locator("#tip.open")).toContainText("Downloading Qwen 3 14B");
  await shot("download-running");
  s.runtime("wrong-service");
  const g = page.locator(".sb-foot button.ibtn").first();
  await g.hover();
  await expect(page.locator("#tip.open")).toContainText("busy");
  await shot("runtime-down");
  s.runtime();
  s.update("available");
  await page.locator(".sb-foot .upd").click();
  await expect(page.getByRole("group", { name: "Confirm update" })).toBeVisible();
  await shot("update-confirm");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Comma");
  await expect(page.locator(".set")).toBeVisible();
  await page.mouse.move(600, 400);
  await shot("settings");
});

test("in place: the phone drawer", async ({ page, open }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open();
  await waitReady(page);
  await dark(page);
  await page.getByRole("button", { name: "Open threads" }).click();
  await expect(page.locator(".sb-foot")).toBeInViewport({ ratio: 1 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: test.info().outputPath("footer-phone-drawer.png"), animations: "disabled", caret: "hide" });
});
