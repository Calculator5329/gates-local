/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { appUrl } from "./env.ts";
import { expect, navButton, test, waitReady } from "./fixtures.ts";

async function general(page: Page) {
  await page.keyboard.press("Control+Comma");
  await navButton(page, "General").click();
  await expect(page.getByTestId("settings.segment.theme-dark")).toBeVisible();
}

// Guards settings arriving by their numbered push: a setting changed in a second window shows in the
// first, whose Settings is open, without that window reading the settings again.
test("a theme picked in a second window shows in the first window's open Settings with no settings read", async ({ page, open, context }) => {
  const reads: string[] = [];
  page.on("websocket", socket => socket.on("framesent", frame => {
    const request = JSON.parse(String(frame.payload)) as { method?: string };
    if (request.method === "settings.get") reads.push(request.method);
  }));
  await open(); await waitReady(page); await general(page);
  const before = reads.length;
  const light = page.getByTestId("settings.segment.theme-light");
  await expect(light).toHaveAttribute("aria-pressed", "false");

  const other = await context.newPage();
  await other.goto(appUrl()); await waitReady(other); await general(other);
  await other.getByTestId("settings.segment.theme-light").click();
  await expect(other.getByTestId("settings.segment.theme-light")).toHaveAttribute("aria-pressed", "true");

  await expect(light, "the first window shows the second window's pick").toHaveAttribute("aria-pressed", "true");
  expect(reads.length - before, "settings.get calls from the first window after its Settings opened").toBe(0);
  await other.close();
});
