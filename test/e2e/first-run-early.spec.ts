// Journey: the person leaves the first window while the chat engine downloads, types a message,
// and the engine then finishes with no model installed. The offer of a first model follows them
// into the chat with its one button; one click downloads it and the waiting message gets its reply.
import { expect, sendMessage, stack, test } from "./fixtures.ts";
import { fakeRuntime, installing } from "./runtime-fake.ts";

test.use({ scenario: "no-models", skipFirstRun: false, video: "off" });

for (const [w, h, tag] of [[1280, 800, "desk"], [390, 844, "phone"]] as const) {
  test.describe(`at ${tag}`, () => {
    test.use({ viewport: { width: w, height: h } });

    // Guards a bug seen on a fresh install: Start chatting during the engine download stored "first
    // run finished", so the model offer never came back and the typed message waited forever.
    test("leaving first run during the engine download still offers the first model", async ({ page, open }, info) => {
      const shot = (name: string) => page.screenshot({ path: info.outputPath(`${name}-${tag}.png`), animations: "disabled" });
      const rt = await fakeRuntime(page, installing);
      // the first model downloads slowly enough to be seen (about 9 s for 6.1 GB)
      await stack.scenario("no-models", { pullTickMs: 400 });
      await open();
      await expect(page.locator(".fr h1")).toHaveText("Getting the chat engine ready");
      await shot("1-engine-downloading");
      await page.getByRole("button", { name: "Start chatting" }).click();
      await sendMessage(page, "Hello from a fresh install");
      // the message waits in its new chat while the engine downloads
      await expect(page.locator(".qt-t")).toHaveText("Hello from a fresh install");
      const installBanner = page.locator(".banner", { hasText: "Getting the chat engine ready" });
      await expect(installBanner).toBeVisible();

      rt.real();
      await expect(installBanner).toHaveCount(0);
      await page.mouse.move(2, 2);
      await shot("2-engine-done");
      const offer = page.locator(".banner", { hasText: "Your message waits for a model" });
      await expect(offer).toBeVisible();
      await expect(offer).toContainText("GB download");
      await offer.getByRole("button", { name: "Download and start" }).click();

      // the download is the model button's bar from here, said once
      await expect(offer).toHaveCount(0);
      await expect(page.locator("#modelBtn .ldbar")).toBeVisible();
      await shot("3-model-downloading");
      // the model is in: the waiting message goes and gets its reply, and the offer is gone
      await expect(page.locator(".turn.a").last().locator(".md")).toContainText("You asked: Hello from a fresh install", { timeout: 30_000 });
      await expect(page.locator(".banner")).toHaveCount(0);
      await shot("4-replied");
    });
  });
}
