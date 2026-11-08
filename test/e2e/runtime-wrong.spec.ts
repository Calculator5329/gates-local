// Journey: something other than Ollama answers on its port. When the user
// chose the system Ollama, chat is blocked with a plain reason everywhere it
// shows. On a first launch the app picks its own copy and routes around the
// taken port, and the first run says so. Nothing crashes.
import { expect, stack, test, waitReady } from "./fixtures.ts";

test.use({ scenario: "wrong-service" });

test.describe("with the system Ollama chosen", () => {
  test.use({ runtimeMode: "system" });
  test("a wrong service on the Ollama port blocks chat and says why", async ({ page, open }) => {
    await open();
    const port = "5288";
    await expect(page.locator(".sb-foot .rt")).toContainText(`Port ${port} · busy`);
    await expect(page.locator(".banner")).toBeVisible();
    await expect(page.locator(".banner")).toContainText(port);
    await expect(page.locator("#ta")).toHaveAttribute("placeholder", "Chat starts when Ollama answers on its port");
    await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();

    await page.locator(".sb-foot .rt").click();
    await expect(page.getByRole("heading", { name: "Runtime" })).toBeVisible();
    await expect(page.locator(".set")).toContainText(`Port ${port} busy`);
    await expect(page.locator(".set")).toContainText(`Something other than Ollama answers on port ${port}.`);
  });

  test("once Ollama answers on the port, Retry looks again and chat is ready (W-06)", async ({ page, open }) => {
    await open();
    await expect(page.locator(".banner")).toContainText("5288");
    // the stack control turns the fake into a healthy Ollama on the same port
    await stack.scenario("models");
    await page.locator(".banner").getByRole("button", { name: "Retry" }).click();
    await waitReady(page);
    await expect(page.locator(".banner")).toHaveCount(0);
  });
});

test("with the app's own copy chosen, the banner says which port is taken instead of asking to start Ollama", async ({ page, open }) => {
  // fresh settings (first run already done): the app picks its own copy and routes around 5288
  await open();
  const banner = page.locator(".banner");
  await expect(banner).toContainText(/Something other than Ollama answers on ports? 5288\b/);
  await expect(banner).toContainText("Gates Local uses its own Ollama on port 5290.");
  await expect(banner).not.toContainText("system-wide");
  await expect(banner).not.toContainText("Start Ollama");
  // the sidebar footer's tooltip tells the same story
  await expect(page.locator(".sb-foot .rt")).toHaveAttribute("data-tip", /Something other than Ollama answers on ports? 5288\b.*own Ollama on port 5290/);
});

test.describe("on first launch", () => {
  test.use({ skipFirstRun: false });
  test("first run says the port is taken and that the app uses its own Ollama", async ({ page, open }) => {
    await open();
    // fresh settings pick the app's own copy; the stack has no Ollama binary, so it is not installed
    await expect(page.getByRole("heading", { name: "Ollama isn't installed" })).toBeVisible();
    // 5288 is the wrong service, 5289 the stack's control server; the app's port is the next free one
    await expect(page.locator(".fr .sub")).toContainText(/Something other than Ollama answers on ports? 5288\b/);
    await expect(page.locator(".fr .sub")).toContainText("Gates Local uses its own Ollama on port 5290.");
    await expect(page.locator(".fr .sub")).not.toContainText("GET /api/version");
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });
});
