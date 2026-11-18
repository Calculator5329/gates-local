// Journey: first launch with Ollama but no models. First run recommends a
// model from models.catalog; Download and start pulls it with models.pull (the
// fake Ollama streams the pull) and opens the chat at once.
import { expect, sendMessage, stack, test } from "./fixtures.ts";

test.use({ scenario: "no-models", skipFirstRun: false });

// Guards the owner's ask for first run with no models: download one, then chat. Scorecard Q15: the
// chat opens with the press, so the first message waits in the composer while the download runs.
test("no models: Download and start opens the chat at once, the first message waits for the download", async ({ page, open }) => {
  await open();
  await expect(page.getByRole("heading", { name: "Download your first model" })).toBeVisible();
  await test.step("inspect the first model recommendation", async () => {
  await expect(page.getByRole("heading", { name: "Download your first model" })).toBeVisible();
  // Ollama is fine, so the status line over the heading is empty; it keeps its height so the heading does not move
  await expect(page.locator(".fr-st")).toHaveText(/^\s*$/);
  expect((await page.locator(".fr-st").boundingBox())?.height ?? 0).toBeGreaterThan(10);
  await expect(page.locator(".fr")).toContainText("Qwen 3.5 9B");
  await expect(page.getByRole("button", { name: "Download and start" })).toBeEnabled();
  await expect(page.locator(".fr")).not.toContainText("not available in this build");
  });
  await page.getByRole("button", { name: "Download and start" }).click();
  await expect(page.locator(".fr"), "the first window is gone with the press").toHaveCount(0);
  await expect(page.locator("#modelBtn .ldbar"), "the download shows on the model button").toBeVisible();
  await sendMessage(page, "Hello there");
  await expect(page.locator(".qt-r .qt-s .vh")).toHaveText("Sends when the download finishes");
  await expect(page.locator(".turn.a .md").last()).toContainText("You asked: Hello there", { timeout: 20_000 });
});

test.describe("when Ollama answers only after the page opened", () => {
  test.use({ scenario: "wrong-service", runtimeMode: "system", controlledRuntimePorts: true });
  // Guards a bug that happened on a fresh Windows install: the catalog read before Ollama answered recommended nothing, so first run sent people to a terminal.
  test("first run offers the recommended download, not a terminal command", async ({ page, open }) => {
    await open();
    // council climb-025 Q16: the busy port offers Gates Local's own Ollama; Retry is the link beside it
    await expect(page.getByTestId("first-run.cta.go")).toHaveText("Use Gates Local's Ollama");
    await expect(page.getByTestId("first-run.cta.link")).toHaveText("Retry");
    await stack.scenario("no-models");
    await page.getByTestId("first-run.cta.link").click();
    await expect(page.getByRole("heading", { name: "Download your first model" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Download and start" })).toBeEnabled();
    await expect(page.locator(".fr")).not.toContainText("ollama pull");
  });
});
