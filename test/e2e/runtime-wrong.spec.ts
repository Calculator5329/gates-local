// Journey: something other than Ollama answers on its port. When the user
// chose the system Ollama, chat is blocked with a plain reason everywhere it
// shows. On a first launch the app picks its own copy and routes around the
// taken port, and the first run says so. Nothing crashes.
import type { Page } from "@playwright/test";
import { expect, stack, test, waitReady } from "./fixtures.ts";

test.use({ scenario: "wrong-service" });

function marked(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(marked);
  if (typeof v !== "object" || v === null) return v;
  const o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, marked(x)]));
  return "owner" in o && "baseUrl" in o ? { ...o, noAppCopy: true } : o;
}

/** Every runtime status reads as on a computer with no build of Ollama for the app to install (Windows ARM today). */
async function noAppCopyHere(page: Page): Promise<void> {
  await page.routeWebSocket(/127\.0\.0\.1:5286/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(typeof m === "string" ? JSON.stringify(marked(JSON.parse(m))) : m));
  });
}

test.describe("with the app's own copy chosen", () => {
  test.use({ runtimeMode: "app" });
  test("on a computer with no copy to run, Settings still offers the way back to the system Ollama", async ({ page, open }) => {
    await noAppCopyHere(page);
    await open();
    await page.locator(".sb-foot .rt").click();
    await page.getByRole("button", { name: "Switch…" }).click();
    await expect(page.getByRole("group", { name: "Confirm switch" })).toContainText("Switch back to the system Ollama?");
  });
});

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

  test("Settings still offers the app's own copy while the system Ollama cannot be used", async ({ page, open }) => {
    await open();
    await page.locator(".sb-foot .rt").click();
    await expect(page.getByRole("heading", { name: "Runtime" })).toBeVisible();
    await page.getByRole("button", { name: "Switch…" }).click();
    await expect(page.getByRole("group", { name: "Confirm switch" })).toContainText("Switch to Gates Local's own copy of Ollama?");
  });

  test("on a computer with no copy to run, Settings says so instead of offering to install it", async ({ page, open }) => {
    await noAppCopyHere(page);
    await open();
    await page.locator(".sb-foot .rt").click();
    await expect(page.getByRole("heading", { name: "Runtime" })).toBeVisible();
    await expect(page.locator(".set")).toContainText("Not available on this computer");
    await expect(page.getByRole("button", { name: "Switch…" })).toHaveCount(0);
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
