// Journey: first launch with Ollama but no models. This build's server does
// not answer models.catalog or models.pull yet, so first run says how to get
// a model by hand; the fixme twin is the full download journey for when the
// v2 model methods land.
import { expect, sendMessage, test } from "./fixtures.ts";

test.use({ scenario: "no-models", skipFirstRun: false });

test("no models: first run explains the download is not available here and offers Retry", async ({ page, open }) => {
  await open();
  await expect(page.getByRole("heading", { name: "Download your first model" })).toBeVisible();
  await expect(page.locator(".fr-st")).toContainText("no models yet");
  await expect(page.locator(".fr")).toContainText("not available in this build");
  await expect(page.locator(".fr")).toContainText("ollama pull qwen3.5:9b");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("heading", { name: "Download your first model" })).toBeVisible();
});

test.fixme("no models: download, cancel, download again, then chat (needs models.catalog and models.pull)", async ({ page, open }) => {
  await open();
  await expect(page.getByRole("heading", { name: "Download your first model" })).toBeVisible();
  await page.getByRole("button", { name: "Download and start" }).click();
  await expect(page.getByRole("heading", { name: "Downloading your first model" })).toBeVisible();
  await expect(page.getByRole("progressbar")).toBeVisible();
  await page.getByRole("button", { name: "Cancel download" }).click();
  await expect(page.locator(".fr-note")).toContainText("Download cancelled");
  await page.getByRole("button", { name: "Download and start" }).click();
  await page.getByRole("button", { name: "Start chatting" }).click();
  await sendMessage(page, "Hello there");
  await expect(page.getByText("Sends when the download finishes")).toBeVisible();
  await expect(page.locator(".turn.a .md").last()).toContainText("You asked: Hello there", { timeout: 20_000 });
});
