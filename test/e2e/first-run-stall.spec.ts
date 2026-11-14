// Journey: the chat engine's download stops sending. Once its figures have held for the app's
// stall time the first window says so and offers Retry; the banner in the chat does the same, and
// Retry gives the new attempt the whole stall time again.
import { expect, test } from "./fixtures.ts";
import { fakeRuntime, installing } from "./runtime-fake.ts";

test.use({ scenario: "no-models", skipFirstRun: false, video: "off" });

for (const [w, h, tag] of [[1280, 800, "desk"], [390, 844, "phone"]] as const) {
  test.describe(`at ${tag}`, () => {
    test.use({ viewport: { width: w, height: h } });

    // Guards a bug seen on a fresh install: a stalled download kept its last figures with nothing to press.
    test("a stalled engine download says so and offers Retry, in the first window and the banner", async ({ page, open }, info) => {
      const shot = (name: string) => page.screenshot({ path: info.outputPath(`${name}-${tag}.png`) });
      // the fake's figures never move: 0.2 of 1.4 GB from the first read on
      await fakeRuntime(page, installing);
      await open();
      await expect(page.locator(".fr h1")).toHaveText("Getting the chat engine ready");
      await expect(page.locator(".fr-st")).toHaveText("Downloading Ollama");
      await expect(page.locator(".fr-st")).toHaveText("Download stalled", { timeout: 10_000 });
      await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
      await expect(page.locator(".fr .sub")).toContainText("of 1.4 GB");
      await page.mouse.move(2, 2);
      await shot("1-first-window-stalled");

      await page.getByRole("button", { name: "Start chatting" }).click();
      const banner = page.locator(".banner", { hasText: "Getting the chat engine ready" });
      await expect(banner).toContainText("Download stalled");
      await page.mouse.move(2, 2);
      await shot("2-banner-stalled");
      await banner.getByRole("button", { name: "Retry" }).click();
      // the new attempt has the whole stall time before it is called stalled again
      await expect(banner).toContainText("Downloading Ollama");
      await expect(banner.getByRole("button", { name: "Retry" })).toHaveCount(0);
    });
  });
}
