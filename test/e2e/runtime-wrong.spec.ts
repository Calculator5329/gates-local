// Journey: something other than Ollama answers on its port. Chat is blocked
// with a plain reason everywhere it shows, and nothing crashes.
import { expect, test } from "./fixtures.ts";

test.use({ scenario: "wrong-service" });

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

test.describe("on first launch", () => {
  test.use({ skipFirstRun: false });
  test("first run says the port is busy and offers Retry", async ({ page, open }) => {
    await open();
    await expect(page.getByRole("heading", { name: "Ollama isn't answering" })).toBeVisible();
    await expect(page.locator(".fr")).toContainText("Something other than Ollama answers on port 5288.");
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });
});
