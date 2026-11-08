/// <reference lib="dom" />
// Journey: the phone path. The real server with the fake Ollama opens its
// phone listener (GATES_LOCAL_WEB_LISTEN=unix:<path>) on an owner-only Unix
// socket; a browser cannot open one, so the stack puts a Tailscale Serve
// stand-in (serve-standin.ts) in front of it on a loopback port, rewriting
// headers as Serve does for a unix: backend (Host localhost, X-Forwarded-Host,
// the source in X-Forwarded-For, its own Tailscale-User-Login). The page
// loads through it at a phone viewport, finds the server on its own origin
// (the same-origin meta) and streams a reply. The upgrade needs Serve's shape
// and the exact Origin, so an open socket proves both reached it. A request
// Serve would stamp with the owner's login but that came from this machine
// (a local dial to its own Tailscale address) is refused.
import { request } from "node:http";
import { networkInterfaces } from "node:os";
import { CONTROL_URL } from "./env.ts";
import { expect, sendMessage, test } from "./fixtures.ts";

test.use({ viewport: { width: 412, height: 915 } });

async function phoneReset(): Promise<{ port: number; socket: string }> {
  const r = await fetch(`${CONTROL_URL}/reset`, { method: "POST", body: JSON.stringify({ scenario: "models", phone: true }) });
  if (!r.ok) throw new Error(`/reset: ${r.status} ${await r.text()}`);
  const { phonePort, phoneSocket } = (await r.json()) as { phonePort?: unknown; phoneSocket?: unknown };
  if (typeof phonePort !== "number" || typeof phoneSocket !== "string") throw new Error("the stack gave no phone port or socket");
  return { port: phonePort, socket: phoneSocket };
}

/** Status of GET / straight to the socket, past the stand-in. */
function direct(socketPath: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = request({ socketPath, path: "/", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    r.on("error", reject);
    r.end();
  });
}

test("a phone loads the client through Serve's stand-in, sends a message and sees the streamed reply", async ({ page }) => {
  const { port, socket } = await phoneReset();
  expect(port < 5286 || port > 5289).toBe(true);
  const origin = `http://127.0.0.1:${port}`;

  // Without Serve's headers the socket refuses even the page.
  expect(await direct(socket, {})).toBe(403);

  // Serve's full shape with this machine as the source: loopback, and an
  // interface address (tailscale0's when it is up) as a local dial to the
  // desktop's own Serve URL would carry.
  const own = Object.values(networkInterfaces()).flatMap((list) => (list ?? []).filter((a) => !a.internal).map((a) => a.address));
  const selves = ["127.0.0.1", "::1", ...own.filter((a) => a.startsWith("100.")).slice(0, 1), ...own.slice(0, 1)];
  for (const self of selves) {
    const r = await fetch(`${origin}/`, { headers: { "x-standin-source": self } });
    expect(r.status, `source ${self}`).toBe(403);
  }
  expect((await fetch(`${origin}/`)).status, "the phone's own source").toBe(200);

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
  // Connected and Ollama ready: the composer is open and a healthy runtime has no footer row
  // (checked only once the composer is up, so an unmounted sidebar cannot pass it).
  await expect(page.locator(".composer:not(.blocked)")).toBeAttached({ timeout: 10_000 });
  await expect(page.locator(".sb-foot .rt .dot")).toHaveCount(0);
  expect(sockets).toEqual([`ws://127.0.0.1:${port}/ws`]);

  await sendMessage(page, "Hello from the phone");
  await expect(page.locator(".turn.a .md").last()).toContainText("You asked: Hello from the phone", { timeout: 10_000 });
  expect(errors, "console errors").toEqual([]);
});
