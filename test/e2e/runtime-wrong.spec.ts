// Journey: something other than Ollama answers on its port. When the user
// chose the system Ollama, chat is blocked with a plain reason everywhere it
// shows, and Retry finds Ollama once it answers. Nothing crashes.
import type { Page } from "@playwright/test";
import { expect, stack, test, waitReady } from "./fixtures.ts";

test.use({ scenario: "wrong-service", controlledRuntimePorts: true });

/** The footer's Settings icon: while the runtime is not ready it carries the old runtime row's words and opens Settings › Runtime. */
const gear = (page: Page) => page.getByTestId("sidebar.foot.settings");

test.describe("with the system Ollama chosen", () => {
  test.use({ runtimeMode: "system" });
  // Guards the owner's rule to show only what is true: chat is blocked and says why (unsure: no direct owner line).
  test("a wrong service on the Ollama port blocks chat and says why", async ({ page, open, runtimePorts }) => {
    await open();
    const port = String(runtimePorts.system);
    await expect(gear(page)).toHaveAccessibleName(`Settings · Port ${port} · busy`);
    await expect(gear(page)).toHaveAttribute("data-tip", new RegExp(`^<b>Port ${port} · busy</b>`));
    await expect(gear(page).locator(".fdot.red")).toBeVisible();
    await expect(page.locator(".banner")).toBeVisible();
    await expect(page.locator(".banner")).toContainText(port);
    await expect(page.locator("#ta")).toHaveAttribute("placeholder", "Chat starts when Ollama answers on its port");
    await expect(page.getByTestId("chat.composer.send")).toBeDisabled();

    await gear(page).click();
    await expect(page.getByRole("heading", { name: "Runtime" })).toBeVisible();
    await expect(page.locator(".set")).toContainText(`Port ${port} busy`);
    await expect(page.locator(".set")).toContainText(`Something other than Ollama answers on port ${port}.`);
  });

  // Guards the W-06 fix: chat stayed blocked after Ollama came back (unsure: an audit item, kept as the only recovery test).
  test("once Ollama answers on the port, Retry looks again and chat is ready (W-06)", async ({ page, open, runtimePorts }) => {
    await open();
    await expect(page.locator(".banner")).toContainText(String(runtimePorts.system));
    // the stack control turns the fake into a healthy Ollama on the same port
    await stack.scenario("models");
    await page.getByTestId("chat.banner.retry").click();
    await waitReady(page);
    await expect(page.locator(".banner")).toHaveCount(0);
  });
});
