/// <reference lib="dom" />
// Journey: the first window holds still. Its heading sits at one height through every state a fresh
// install passes on a build that installs its own Ollama (looking for one, its own downloading, its
// own starting, Ollama ready with no model, the first model downloading, the model ready); what
// changes below it changes in place. Such a build never says "isn't installed": it installs.
import { expect, stack, test } from "./fixtures.ts";
import { fakeRuntime, installing, startingOwn } from "./runtime-fake.ts";

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
      rt.real();
      await at("runtime-ready", "Download your first model");
      await page.getByRole("button", { name: "Download and start" }).click();
      await at("model-downloading", "Downloading your first model");
      await expect(heading).toHaveText("Ready to chat", { timeout: 30_000 });
      await at("model-ready", "Ready to chat");
      await info.attach("heading tops", { body: JSON.stringify(tops, null, 2), contentType: "application/json" });
      const first = tops["looking"] ?? Number.NaN;
      const moved = Object.fromEntries(Object.entries(tops).filter(([, y]) => Math.abs(y - first) > 0.5));
      expect(moved, `heading tops by state: ${JSON.stringify(tops)}`).toEqual({});
    });
  });
}
