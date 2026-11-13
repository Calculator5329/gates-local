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
import type { Page } from "@playwright/test";
import { CONTROL_URL } from "./env.ts";
import { fakeComfy } from "./fake-comfy.ts";
import { expect, sendMessage, stack, test } from "./fixtures.ts";

test.use({ viewport: { width: 412, height: 915 } });

let comfy: Awaited<ReturnType<typeof fakeComfy>> | undefined;
test.afterEach(async () => { await comfy?.close(); comfy = undefined; });

async function phoneReset(seed?: "design", image?: { comfyUrl: string }): Promise<{ port: number; socket: string }> {
  const body = { scenario: "models", phone: true, seed, ...(image === undefined ? {} : { comfyUrl: image.comfyUrl, imageTool: true }) };
  const r = await fetch(`${CONTROL_URL}/reset`, { method: "POST", body: JSON.stringify(body) });
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
  // Connected and Ollama ready: the composer is open and a healthy runtime puts no dot on the footer's Settings icon
  // (checked only once the composer is up, so an unmounted sidebar cannot pass it).
  await expect(page.locator(".composer:not(.blocked)")).toBeAttached({ timeout: 10_000 });
  // the drawer is closed, so match the mounted gear by its label rather than by role
  await expect(page.locator('.sb-foot button[aria-label="Settings"]')).toHaveCount(1);
  await expect(page.locator(".sb-foot .fdot")).toHaveCount(0);
  expect(sockets).toEqual([`ws://127.0.0.1:${port}/ws`]);

  await sendMessage(page, "Hello from the phone");
  await expect(page.locator(".turn.a .md").last()).toContainText("You asked: Hello from the phone", { timeout: 10_000 });
  expect(errors, "console errors").toEqual([]);
});

/**
 * The controls each section must at least offer on a phone; a section at 0 shows only read-only rows there.
 * Tools has the two Library rows' links: its switches change settings, which a phone cannot, so they are words there.
 */
const SETTINGS_SECTIONS = [["General", 0], ["Models", 4], ["Instructions", 2], ["Library", 0], ["Tools", 2], ["Image generation", 0], ["Runtime", 1], ["Advanced", 0], ["Shortcuts", 0]] as const;

/** Which requests are still unanswered, and which the server refused as computer-only. */
function watchRequests(page: Page): { open: Map<string, string>; refused: string[] } {
  const open = new Map<string, string>();
  const refused: string[] = [];
  page.on("websocket", (ws) => {
    ws.on("framesent", ({ payload }) => {
      const { id, method } = JSON.parse(payload.toString()) as { id?: string; method?: string };
      if (id !== undefined && method !== undefined) open.set(id, method);
    });
    ws.on("framereceived", ({ payload }) => {
      const { type, id, error } = JSON.parse(payload.toString()) as { type?: string; id?: string; error?: { code?: string } };
      if (type !== "response" || id === undefined) return;
      if (error?.code === "forbidden") refused.push(open.get(id) ?? id);
      open.delete(id);
    });
  });
  return { open, refused };
}

async function showSection(page: Page, section: string): Promise<void> {
  if ((await page.locator('[role="menu"]:visible').count()) > 0) await page.keyboard.press("Escape");
  const bar = page.locator(".set-bar h2");
  if ((await bar.isVisible()) && (await bar.textContent()) === section) return;
  const back = page.getByRole("button", { name: "Back to Settings" });
  if (await back.isVisible()) await back.click();
  if (!(await page.locator(".set-list").isVisible())) {
    await page.getByRole("button", { name: "Open threads" }).click();
    await page.locator(".sb").getByRole("button", { name: "Settings" }).click();
  }
  await page.locator(".set-list").getByRole("button", { name: section }).click();
  await expect(bar).toHaveText(section);
}

/**
 * Taps every button and switch a section shows, once each from a clean section, and answers how
 * many there were. It covers controls that write on the first tap; a write behind a confirmation
 * or inside a menu is not reached.
 */
async function tapEverything(page: Page, section: string, atLeast: number): Promise<number> {
  await showSection(page, section);
  const controls = page.locator('.set-in :is(button, [role="switch"]):visible:not([disabled])');
  await expect.poll(() => controls.count(), { message: `controls in ${section}` }).toBeGreaterThanOrEqual(atLeast);
  const count = await controls.count();
  for (let i = 0; i < count; i++) {
    await showSection(page, section);
    if ((await controls.count()) > i) await controls.nth(i).click({ timeout: 5000 });
  }
  return count;
}

test("the phone reads, sends, stops and switches models, and nothing it offers is refused", async ({ page }) => {
  test.setTimeout(120_000);
  // image generation set up on the computer, with Tools › Make images on
  comfy = await fakeComfy();
  const { port } = await phoneReset("design", { comfyUrl: comfy.url });
  const { open, refused } = watchRequests(page);
  await page.addInitScript(() => localStorage.setItem("gates-local.first-run-done", "1"));
  await page.goto(`http://127.0.0.1:${port}/`);
  await expect(page.locator(".composer:not(.blocked)")).toBeAttached({ timeout: 10_000 });

  // Open a thread from the drawer; its menu can rename but not delete.
  await page.getByRole("button", { name: "Open threads" }).click();
  await page.locator(".sb .sb-row .sb-thread").first().focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.locator("#threadMenu")).toHaveClass(/\bopen\b/);
  await expect(page.locator("#threadMenu").getByRole("menuitem", { name: "Rename" })).toBeVisible();
  await expect(page.locator("#threadMenu").getByRole("menuitem", { name: "Delete thread" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.locator(".sb .sb-row .sb-thread").first().click();
  await expect(page.locator(".turn").first()).toBeVisible();

  // Send, then stop while the reply is still coming.
  await stack.scenario("slow-drip", { holdAfterTokens: 46 });
  await sendMessage(page, "Stop this one");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator(".turn.a .a-act.stop .s").last()).toHaveText(/^\d+ s$/);
  await stack.scenario("models");

  // Pick another installed model. Downloading a new one is not offered.
  await page.locator("#modelBtn").click();
  await expect(page.locator("#picker").getByRole("button", { name: "Download models" })).toHaveCount(0);
  await page.locator('#picker .pk-r[data-m="gemma4:12b"] .pk-select').click();
  await page.locator('#picker [data-ctx="32768"]').click();
  await expect(page.locator("#picker")).toBeHidden({ timeout: 10_000 });
  await expect(page.locator("#modelBtn")).toContainText("Gemma 4 12B");

  await page.getByRole("button", { name: "Open threads" }).click();
  await page.locator(".sb").getByRole("button", { name: "Settings" }).click();
  await expect(page.locator(".set-list")).toBeVisible();

  await showSection(page, "Models");
  await expect(page.getByRole("tab", { name: "Installed" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Download" })).toHaveCount(0);
  await page.locator(".mp-kebab").first().click();
  await expect(page.getByRole("menuitem", { name: "Copy Ollama name" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Use as default|Remove/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await showSection(page, "Library");
  await expect(page.locator(".set-in")).toContainText("Available on the computer.");

  // Tap every control the phone still shows: a first-tap writer someone forgot to gate is refused here.
  const tapped: Record<string, number> = {};
  for (const [section, atLeast] of SETTINGS_SECTIONS) tapped[section] = await tapEverything(page, section, atLeast);
  console.log(`TAPPED ${JSON.stringify(tapped)}`);

  // Make images, turned on at the computer: the phone shows it on, with no switch to tap.
  await showSection(page, "Tools");
  const makeImages = page.locator('.set-in [data-tool="images"]');
  await expect(makeImages).toContainText("Make images");
  await expect(makeImages.locator(".sv")).toHaveText("On");
  await expect(makeImages.getByRole("switch")).toHaveCount(0);

  await expect.poll(() => [...open.values()], { message: "every request was answered" }).toEqual([]);
  expect(refused, "no control that writes on the first tap was refused (confirmations and menu items are not tapped)").toEqual([]);
});
