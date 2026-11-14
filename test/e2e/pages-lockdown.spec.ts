/// <reference lib="dom" />
// A page is the model's code, so it runs locked down. A probe page tries each
// way out and writes what happened into itself; the tests read that, and check
// the app's side: the frame's attributes, no message listener, the app's own
// frame policy, and the page's own window.
import { appendFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { BIG_PROMPT, LEFT_PATH, LOAN_PROMPTS, MOVING, NAVIGATE_PROMPT, PROBE_PROMPT } from "../fake-ollama/page-replies.ts";
import { FAKE_URL, SERVER_PORT, TOKEN, WEB_ORIGIN } from "./env.ts";
import { expect, test, waitReady } from "./fixtures.ts";
import { INSTALLED, configure, start } from "./threads-support.ts";

// what the browser logs when it refuses the page something; one pattern, since
// test.use reads a two-entry array whose second entry is an object as [value, options]
const REFUSALS = /Content Security Policy|Refused to|ERR_BLOCKED_BY|Blocked (opening|script execution|a frame|form)|sandbox|Unsafe attempt to initiate navigation|Failed to load resource/i;
test.use({ installed: INSTALLED, allowedErrors: [REFUSALS] });

const frameEl = (page: Page) => page.getByTestId("pages.frame");

async function pageOf(page: Page, prompt: string, timeout = 20_000, frame = true): Promise<void> {
  await configure();
  await start(page, prompt);
  await expect(page.locator(".turn.a.done")).toHaveCount(1, { timeout });
  if (frame) await expect(frameEl(page)).toBeVisible();
}

/** A served page's address: the server's page route under a one-time id, nothing else. */
const PAGE_ADDRESS = new RegExp(`^http://127\\.0\\.0\\.1:${SERVER_PORT}/pages/[0-9a-f]{32}$`);

/** What the fake server was asked by anything that left a page's limits. */
const leftRequests = async () => ((await (await fetch(`${FAKE_URL}/__fake/state`)).json()) as { requests: { path: string }[] }).requests.map((r) => r.path).filter((p) => p.startsWith(LEFT_PATH));

test("the frame is the server's one-time page address, sandboxed to scripts only, with no referrer and no token", async ({ page, open }) => {
  await open(); await waitReady(page);
  const policies: string[] = [];
  page.on("response", (r) => { if (PAGE_ADDRESS.test(r.url())) policies.push(r.headers()["content-security-policy"] ?? "none"); });
  await pageOf(page, LOAN_PROMPTS[0]);
  await expect(page.frameLocator('[data-testid="pages.frame"]').locator("#monthly")).toHaveText("$489.15");
  const attrs = await frameEl(page).evaluate((f: HTMLIFrameElement) => ({ sandbox: f.getAttribute("sandbox"), referrer: f.referrerPolicy, src: f.src, srcdoc: f.hasAttribute("srcdoc") }));
  expect(attrs).toEqual({ sandbox: "allow-scripts", referrer: "no-referrer", src: expect.stringMatching(PAGE_ADDRESS), srcdoc: false });
  expect(attrs.src).not.toContain(TOKEN);
  // the limits come with the page, as the server's header
  expect(policies).toHaveLength(1);
  expect(policies[0]).toContain("default-src 'none'");
  expect(policies[0]).toContain("frame-src 'none'");
  expect(policies[0]).toContain("sandbox allow-scripts");
  // the address served once: asked again, it answers nothing
  const again = await fetch(attrs.src);
  expect(again.status).toBe(404);
  expect(await again.text()).toBe("");
});

test("a page learns nothing of the app and reaches nothing outside its frame", async ({ page, open }) => {
  await open(); await waitReady(page);
  await pageOf(page, PROBE_PROMPT);
  const out = page.frameLocator('[data-testid="pages.frame"]').locator("#out");
  await expect(out).not.toHaveText("running");
  const r = JSON.parse(await out.innerText()) as Record<string, unknown>;
  test.info().annotations.push({ type: "probe", description: JSON.stringify(r) });
  // the address: no referrer, the server's page address, nothing with the token in it
  expect.soft(r["referrer"]).toBe("");
  expect.soft(r["href"]).toMatch(PAGE_ADDRESS);
  expect.soft(r["base"]).toMatch(PAGE_ADDRESS);
  expect.soft(JSON.stringify(r)).not.toContain(TOKEN);
  expect.soft(JSON.stringify(r)).not.toContain("token");
  // the app's window
  expect.soft(r["parentDocument"]).toBe("threw SecurityError");
  expect.soft(r["parentHref"]).toBe("threw SecurityError");
  expect.soft(r["topHref"]).toBe("threw SecurityError");
  // storage
  expect.soft(r["localStorage"]).toBe("threw SecurityError");
  expect.soft(r["sessionStorage"]).toBe("threw SecurityError");
  expect.soft(r["cookie"]).toBe("threw SecurityError");
  expect.soft(r["indexedDB"]).toBe("threw SecurityError");
  // the network, from its policy: nothing goes out, pictures only from data:
  expect.soft(r["fetched"]).toBe("failed TypeError");
  expect.soft(r["webImage"]).toBe("failed");
  expect.soft(r["dataImage"]).toBe("loaded");
  expect.soft(r["violations"]).toEqual(expect.arrayContaining(["connect-src", "img-src", "script-src"]));
  expect.soft(r["eval"]).toBe("threw EvalError");
  // WebRTC and popups: no constructor, and no frame of its own to find one in
  expect.soft(r["rtc"]).toBe("undefined,undefined,undefined");
  expect.soft(r["rtcNew"]).toBe("threw TypeError");
  expect.soft(r["nestedRtc"]).toMatch(/^(undefined|threw SecurityError)$/);
  expect.soft(r["childFrame"]).toBe("refused");
  expect.soft(r["popup"]).toBe("null");
  // what the page is told of the windows around it, recorded with the results
  await appendFile(test.info().outputPath("notes.txt"), `probe: ${JSON.stringify(r)}\n`);
});

test("a page too big to run shows its code and says so", async ({ page, open }) => {
  test.info().annotations.push({ type: "budget", description: "a 2 MiB reply goes through the server and the socket" });
  await open(); await waitReady(page);
  // past the server's page limit the panel says so with its size, and shows the code
  await pageOf(page, BIG_PROMPT, 60_000, false);
  await expect(page.getByTestId("pages.panel")).toBeVisible();
  await expect(page.getByTestId("pages.too-big")).toHaveText(/^Too big to run here · 2\.\d MB$/);
  await expect(page.getByTestId("pages.panel.source")).toContainText("<title>Big page</title>");
  await expect(page.getByTestId("pages.frame")).toHaveCount(0);
});

test("the app does not listen for a page's messages", async ({ page, open }) => {
  await open(); await waitReady(page);
  await pageOf(page, PROBE_PROMPT);
  const cdp = await page.context().newCDPSession(page);
  const { result } = await cdp.send("Runtime.evaluate", { expression: "window" });
  const { listeners } = await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId! });
  expect(listeners.filter((l) => l.type === "message" || l.type === "messageerror").map((l) => l.type)).toEqual([]);
});

test("a page cannot move the app's window, and its frame cannot load anything but a page", async ({ page, open }) => {
  await open(); await waitReady(page);
  const documents: string[] = [];
  page.on("response", (r) => { if (r.request().frame() !== page.mainFrame() && r.request().resourceType() === "document") documents.push(r.url()); });
  const at = await (async () => { await pageOf(page, NAVIGATE_PROMPT); return page.url(); })();
  // the page moves its own frame to the app's address 100 ms after it runs
  await page.waitForTimeout(1500);
  expect(page.url()).toBe(at);
  expect(documents.filter((u) => u.startsWith(WEB_ORIGIN))).toEqual([]);
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    expect(f.url().startsWith(WEB_ORIGIN) && await f.locator("#app").count().catch(() => 0)).toBeFalsy();
  }
  // the app document's own policy refuses any frame but the server's page route, a data: page too
  for (const src of [`${WEB_ORIGIN}/`, "data:text/html,<p>unlimited</p>"]) {
    const refused = await page.evaluate((url) => new Promise<string>((done) => {
      document.addEventListener("securitypolicyviolation", (e) => done(e.effectiveDirective), { once: true });
      const f = document.createElement("iframe");
      f.src = url;
      document.body.append(f);
      setTimeout(() => { f.remove(); done("loaded"); }, 2000);
    }), src);
    expect(refused, src).toBe("frame-src");
  }
});

// Each of these pages tries to put itself somewhere its limits do not follow: a document of its
// own (a data: address carries no header), the fake server's address, or a refresh tag to either.
// Their limits come with the page as a header, and the app frames nothing but the page route, so
// the frame stays put or ends on the browser's error page, and the fake server is asked nothing.
for (const [label, { prompt }] of Object.entries(MOVING)) {
  test(`a page that moves its frame to ${label} stays where it is and reaches nothing`, async ({ page, open }) => {
    await open(); await waitReady(page);
    const before = await leftRequests();
    await pageOf(page, prompt);
    const at = page.url();
    await page.waitForTimeout(1500);
    expect(page.url()).toBe(at);
    const frames = page.frames().filter((f) => f !== page.mainFrame()).map((f) => f.url());
    test.info().annotations.push({ type: "frames", description: frames.join(" ") });
    expect(frames.length).toBeGreaterThan(0);
    for (const url of frames) {
      expect(url.startsWith("data:"), url).toBe(false);
      expect(url.startsWith(FAKE_URL), url).toBe(false);
      expect(PAGE_ADDRESS.test(url) || url.startsWith("chrome-error:"), url).toBe(true);
    }
    expect(await leftRequests()).toEqual(before);
  });
}

test("open in its own window: a blank window holding the same locked frame, cut from the app", async ({ page, open }) => {
  await open(); await waitReady(page);
  await pageOf(page, LOAN_PROMPTS[0]);
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.getByTestId("pages.panel.open-window").click()]);
  expect(popup.url()).toBe("about:blank");
  // the frame comes once the server has the page
  await expect(popup.frameLocator("iframe").locator("#monthly")).toHaveText("$489.15");
  const inside = await popup.evaluate(() => {
    const f = document.querySelector("iframe");
    return { opener: window.opener === null, title: document.title, sandbox: f?.getAttribute("sandbox"), referrer: f?.referrerPolicy, src: f?.src ?? "" };
  });
  expect(inside).toEqual({ opener: true, title: "Loan calculator", sandbox: "allow-scripts", referrer: "no-referrer", src: expect.stringMatching(PAGE_ADDRESS) });
  expect(inside.src).not.toContain(TOKEN);
  await popup.close();
});
