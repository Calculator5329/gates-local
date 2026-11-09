// Journey: first launch with Ollama but no models. First run recommends a
// model from models.catalog and downloads it with models.pull (the fake
// Ollama streams the pull), with Cancel, then the chat opens.
import { expect, sendMessage, test } from "./fixtures.ts";

test.use({ scenario: "no-models", skipFirstRun: false });

test("no models: download, cancel, download again, then chat", async ({ page, open }) => {
  await open();
  await expect(page.getByRole("heading", { name: "Download your first model" })).toBeVisible();
  await test.step("inspect the first model recommendation", async () => {
  await expect(page.getByRole("heading", { name: "Download your first model" })).toBeVisible();
  await expect(page.locator(".fr-st")).toContainText("no models yet");
  await expect(page.locator(".fr")).toContainText("Qwen 3.5 9B");
  await expect(page.getByRole("button", { name: "Download and start" })).toBeEnabled();
  await expect(page.locator(".fr")).not.toContainText("not available in this build");
  });
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
