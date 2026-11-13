// The owner asked for the Ollama version to go ("Ollama 0.40.4 · system").
// The fake runtime reports 0.40.4, so any screen that still prints it fails.
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

test.use({ skipFirstRun: false });

const FAKE_VERSION = "0.40.4";
const noVersion = (page: Page) => expect(page.locator("body")).not.toContainText(FAKE_VERSION);

// Guards the owner's ruling (R24): no screen shows the Ollama version.
test("no screen prints the version of Ollama", async ({ page, open }) => {
  await open();
  await expect(page.getByRole("heading", { name: "Ready to chat" })).toBeVisible();
  await noVersion(page);

  await page.getByRole("button", { name: "Start chatting" }).click();
  await expect(page.locator("#ta")).toBeFocused();
  await noVersion(page);

  await page.keyboard.press("Control+Comma");
  await page.getByTestId("settings.nav.open-runtime").click();
  await expect(page.locator(".snav")).toBeVisible();
  await noVersion(page);
});
