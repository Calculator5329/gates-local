// Journey: something other than Ollama answers on its port. When the user
// chose the system Ollama, chat is blocked with a plain reason everywhere it
// shows. On a first launch the app picks its own copy and routes around the
// taken port, and the first run says so. Nothing crashes.
import { expect, test } from "./fixtures.ts";

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
