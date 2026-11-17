/// <reference lib="dom" />
// Journeys: a fresh install while the chat engine downloads, at desktop and phone width.
// - The first window holds still. Its heading sits at one height through every state a fresh
//   install passes on a build that installs its own Ollama (looking for one, its own downloading,
//   its own starting, the first model downloading by itself, the model ready); what changes below
//   it changes in place. Such a build never says "isn't installed": it installs.
// - The person leaves the first window while the engine downloads, types a message, and the engine
//   then finishes with no model installed. The first model starts downloading by itself, shown on
//   the model button, and the waiting message gets its reply.
// - The engine's download stops sending. Once the server says it stalled (its figures held for the
//   server's stall time) the first window says so and offers Retry; the banner in the chat does the
//   same, and Retry's new attempt reads as downloading again.
import { expect, sendMessage, stack, test } from "./fixtures.ts";
import { fakeRuntime, installing, stalled, startingOwn } from "./runtime-fake.ts";

test.use({ scenario: "no-models", skipFirstRun: false, video: "off" });

for (const [w, h, tag] of [[1280, 800, "desk"], [390, 844, "phone"]] as const) {
  test.describe(`at ${tag}`, () => {
    test.use({ viewport: { width: w, height: h } });

    // Guards a bug seen on a fresh install: the first window was centred, so its heading jumped between states.
    test("the first window's heading stays at one height through a fresh install", async ({ page, open }, info) => {
      const rt = await fakeRuntime(page);
      // the first model downloads slowly enough to be seen (about 9 s for 6.1 GB)
      await stack.scenario("no-models", { pullTickMs: 400 });
      await open();
      const heading = page.locator(".fr h1");
      const status = page.locator(".fr-st");
      const tops: Record<string, number> = {};
      const at = async (state: string, title: string, line?: string) => {
        await expect(heading).toHaveText(title);
        if (line !== undefined) await expect(status).toHaveText(line);
        await page.mouse.move(2, 2);
        tops[state] = (await heading.boundingBox())?.y ?? Number.NaN;
        await page.screenshot({ path: info.outputPath(`${state}-${tag}.png`) });
      };
      await at("looking", "Starting up", "Looking for Ollama");
      rt.set(installing);
      await at("fetching-runtime", "Getting the chat engine ready", "Downloading Ollama");
      rt.set(startingOwn);
      await at("starting-runtime", "Starting up", "Starting Ollama");
      // its own Ollama up: the first model starts downloading with no second ask (scorecard Q15)
      rt.real();
      await at("model-downloading", "Downloading your first model");
      await expect(heading).toHaveText("Ready to chat", { timeout: 30_000 });
      await at("model-ready", "Ready to chat");
      await info.attach("heading tops", { body: JSON.stringify(tops, null, 2), contentType: "application/json" });
      const first = tops["looking"] ?? Number.NaN;
      const moved = Object.fromEntries(Object.entries(tops).filter(([, y]) => Math.abs(y - first) > 0.5));
      expect(moved, `heading tops by state: ${JSON.stringify(tops)}`).toEqual({});
    });

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
      // its own Ollama up: the first model starts at once, as the model button's bar, said once (scorecard Q15)
      await expect(page.locator("#modelBtn .ldbar")).toBeVisible();
      await expect(page.locator(".banner", { hasText: "Your message waits for a model" })).toHaveCount(0);
      await page.mouse.move(2, 2);
      await shot("2-engine-done");
      await shot("3-model-downloading");
      // the model is in: the waiting message goes and gets its reply, and the offer is gone
      await expect(page.locator(".turn.a").last().locator(".md")).toContainText("You asked: Hello from a fresh install", { timeout: 30_000 });
      await expect(page.locator(".banner")).toHaveCount(0);
      await shot("4-replied");
    });

    // Guards a bug seen on a fresh install: a stalled download kept its last figures with nothing to press.
    test("a stalled engine download says so and offers Retry, in the first window and the banner", async ({ page, open }, info) => {
      const shot = (name: string) => page.screenshot({ path: info.outputPath(`${name}-${tag}.png`) });
      // the fake's figures never move: 0.2 of 1.4 GB from the first read on, until the server calls it stalled
      const rt = await fakeRuntime(page, installing, { retry: installing });
      await open();
      await expect(page.locator(".fr h1")).toHaveText("Getting the chat engine ready");
      await expect(page.locator(".fr-st")).toHaveText("Downloading Ollama");
      rt.set(stalled);
      await expect(page.locator(".fr-st")).toHaveText("Download stalled");
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
      // the server starts the download again and answers the new attempt, which is downloading
      await expect(banner).toContainText("Downloading Ollama");
      await expect(banner.getByRole("button", { name: "Retry" })).toHaveCount(0);
    });
  });
}
