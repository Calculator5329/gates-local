/// <reference lib="dom" />
// Settings › Image generation while Set up images runs. Its engine step installs the app's own
// engine, so from the model step on the server reports that engine, stopped: the setup row must
// follow the setup, not the engine, or it vanishes for the whole model download (about 9 GB) and
// "Setup stopped" has nowhere to show. A "done" pushed while the socket is down must not leave
// "Setting up…" behind either: a reconnect reads the setup again. The engine and the model files
// are the test's fake ComfyUI's (fake-comfy.ts engine()); nothing is fetched from anywhere else.
import type { Page } from "@playwright/test";
import { fakeComfy } from "./fake-comfy.ts";
import { expect, stack, test, waitReady } from "./fixtures.ts";

test.use({ video: "off", allowedErrors: [[/WebSocket connection to .* failed/, /Failed to load resource.*503/], { scope: "test" }] });
let comfy: Awaited<ReturnType<typeof fakeComfy>>;
test.beforeEach(async () => { comfy = await fakeComfy(); comfy.down(true); comfy.bare(); comfy.withFolders(); });
test.afterEach(async () => { await comfy.close(); });

const phone = (page: Page) => (page.viewportSize()?.width ?? 1440) <= 640;

/** Settings at a section, through the list on a phone and the side nav elsewhere. */
async function section(page: Page, id: string) {
  if (phone(page)) {
    await page.getByTestId("settings.shell.back").click();
    await page.getByTestId(`settings.sections.open-${id}`).click();
  } else await page.getByTestId(`settings.nav.open-${id}`).click();
}

/**
 * The socket, with a switch that drops the setup's last word ("done" or "error") and a way to cut
 * the connection, so the app reconnects on a fresh one (which passes everything).
 */
async function socket(page: Page) {
  const ctl = { dropEnds: false, dropped: false, cut: () => {} };
  let first = true;
  await page.routeWebSocket(/\/\?token=/, (ws) => {
    const mine = first;
    first = false;
    const server = ws.connectToServer();
    ws.onMessage((raw) => server.send(raw));
    server.onMessage((raw) => {
      if (mine && ctl.dropEnds && typeof raw === "string") {
        const m = JSON.parse(raw) as { type?: string; channel?: string; payload?: { step?: string } };
        if (m.type === "push" && m.channel === "image.setup" && (m.payload?.step === "done" || m.payload?.step === "error")) { ctl.dropped = true; return; }
      }
      ws.send(raw);
    });
    if (mine) ctl.cut = () => { void ws.close(); void server.close(); };
  });
  return ctl;
}

for (const [w, h, tag] of [[1280, 800, "desk"], [390, 844, "phone"]] as const) {
  test.describe(`at ${tag}`, () => {
    test.use({ viewport: { width: w, height: h } });

    test("the setup row stays through the model step, and a lost last word clears on reconnect", async ({ page, open }, info) => {
      const ctl = await socket(page);
      await stack.reset("models", 0, undefined, "system", undefined, undefined, false, "ready", comfy.engine());
      await open(); await waitReady(page);
      await page.keyboard.press("Control+Comma");
      await section(page, "images");
      const setUp = page.getByTestId("settings.images.set-up");
      const row = page.locator(".srow", { has: setUp });
      // the model download held part way: the engine is in, the server now reports it as the app's own
      comfy.slowDownloads(true);
      await setUp.click();
      await expect(row).toContainText("Downloading the image model", { timeout: 30_000 });

      // Settings opened again mid-setup (another section, then back): the row is still the setup's
      await section(page, "general");
      await section(page, "images");
      await page.waitForTimeout(500);
      await page.mouse.move(2, 2);
      await page.screenshot({ path: info.outputPath(`setup-remount-${tag}.png`) });
      await expect(setUp, "the setup row after Settings opened again during the model step").toBeVisible();
      await expect(row).toContainText("Downloading the image model");
      await expect(setUp).toHaveText(/Setting up…/);
      await expect(page.getByTestId("settings.images.enable")).toHaveCount(0);

      // the setup ends while its "done" is lost; the next connection reads the setup again
      ctl.dropEnds = true;
      comfy.slowDownloads(false);
      await expect.poll(() => ctl.dropped, { timeout: 60_000 }).toBe(true);
      // without it the row would say Setting up… for good
      await expect(setUp).toHaveText(/Setting up…/);
      ctl.cut();
      await expect(page.getByTestId("settings.images.enable"), "the switch, once the setup is read again").toBeVisible({ timeout: 60_000 });
      await expect(setUp).toHaveCount(0);
      await page.mouse.move(2, 2);
      await page.screenshot({ path: info.outputPath(`setup-reconnect-${tag}.png`) });
    });
  });
}
