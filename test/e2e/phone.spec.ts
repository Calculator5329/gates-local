/// <reference lib="dom" />
// Journey: the phone path. The real server with the fake Ollama opens its
// phone listener (GATES_LOCAL_WEB_LISTEN) on a free port; the page loads from
// that listener, not the preview build, at a phone viewport, finds the server
// on its own origin (the same-origin meta) and streams a reply. Playwright's
// extraHTTPHeaders stands in for Tailscale Serve's Tailscale-User-Login; the
// listener refuses the upgrade without it, so an open socket proves the
// header reached the upgrade too.
import { CONTROL_URL, PHONE_USER } from "./env.ts";
import { expect, sendMessage, test } from "./fixtures.ts";

test.use({ viewport: { width: 412, height: 915 }, extraHTTPHeaders: { "Tailscale-User-Login": PHONE_USER } });

async function phoneReset(): Promise<number> {
  const r = await fetch(`${CONTROL_URL}/reset`, { method: "POST", body: JSON.stringify({ scenario: "models", phone: true }) });
  if (!r.ok) throw new Error(`/reset: ${r.status} ${await r.text()}`);
  const { phonePort } = (await r.json()) as { phonePort?: unknown };
  if (typeof phonePort !== "number") throw new Error("the stack gave no phone port");
  return phonePort;
}

test("a phone loads the client from the phone listener, sends a message and sees the streamed reply", async ({ page }) => {
  const port = await phoneReset();
  expect(port < 5286 || port > 5289).toBe(true);
  const origin = `http://127.0.0.1:${port}`;

  // Without the header the listener refuses even the page.
  expect((await fetch(`${origin}/`)).status).toBe(403);

  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const sockets: string[] = [];
  page.on("websocket", (ws) => sockets.push(ws.url()));
  await page.addInitScript(() => localStorage.setItem("gates-local.first-run-done", "1"));

  await page.goto(`${origin}/`);
  expect(await page.locator('meta[name="gates-local-server"]').getAttribute("content")).toBe("same-origin");
  // Connected and Ollama ready; attached rather than visible, since the sidebar may fold away at phone width.
  await expect(page.locator(".sb-foot .rt .dot.ok")).toBeAttached({ timeout: 10_000 });
  expect(sockets).toEqual([`ws://127.0.0.1:${port}/ws`]);

  await sendMessage(page, "Hello from the phone");
  await expect(page.locator(".turn.a .md").last()).toContainText("You asked: Hello from the phone", { timeout: 10_000 });
  expect(errors, "console errors").toEqual([]);
});
