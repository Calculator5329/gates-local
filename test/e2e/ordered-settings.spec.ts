// Real independent windows, server and speech stand-in. Ordering races are
// explored by production-session replays; this checks their visible projection.
import type { Page } from "@playwright/test";
import { fakeWhisper } from "../../apps/server/src/voice/testing.ts";
import { appUrl } from "./env.ts";
import { expect, test, waitReady } from "./fixtures.ts";

async function general(page: Page) {
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "General", exact: true }).click();
  await expect(page.getByRole("heading", { name: "General" })).toBeVisible();
}

test("two windows share ordered theme and speech settings across hydration and disconnect", async ({ page, open, context }) => {
  const speech = await fakeWhisper();
  const other = await context.newPage();
  const errors: string[] = [];
  other.on("pageerror", error => errors.push(error.message));
  other.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  try {
    await open(); await waitReady(page); await general(page);
    await other.goto(appUrl()); await waitReady(other); await general(other);
    await page.getByRole("textbox", { name: "whisper.cpp address" }).fill(speech.url);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    for (const window of [page, other]) await expect(window.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
    await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Light", exact: true }).click();
    for (const window of [page, other]) await expect(window.locator("html")).toHaveAttribute("data-theme", "light");
    await other.reload(); await waitReady(other); await general(other);
    await expect(other.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(other.getByRole("textbox", { name: "whisper.cpp address" })).toHaveValue(speech.url);
    await other.getByRole("button", { name: "Disconnect", exact: true }).click();
    for (const window of [page, other]) {
      await expect(window.getByRole("button", { name: "Disconnect", exact: true })).toHaveCount(0);
      await expect(window.getByText("Off. Connect your running local server to use the microphone.", { exact: true })).toBeVisible();
    }
    await other.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Dark", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload(); await waitReady(page); await general(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await other.close(); await speech.close(); }
});
