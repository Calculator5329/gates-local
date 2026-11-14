/// <reference lib="dom" />
// A page is the model's code, so it runs locked down. A probe page tries each
// way out and writes what happened into itself; the tests read that, and check
// the app's side: the frame's attributes, no message listener, the app's own
// frame policy, and the page's own window.
import type { Page } from "@playwright/test";
import { LOAN_PROMPTS, NAVIGATE_PROMPT, PROBE_PROMPT } from "../fake-ollama/page-replies.ts";
import { TOKEN, WEB_ORIGIN } from "./env.ts";
import { expect, test, waitReady } from "./fixtures.ts";
import { INSTALLED, configure, start } from "./threads-support.ts";

// what the browser logs when it refuses the page something; one pattern, since
// test.use reads a two-entry array whose second entry is an object as [value, options]
const REFUSALS = /Content Security Policy|Refused to|ERR_BLOCKED_BY|Blocked (opening|script execution|a frame|form)|sandbox|Unsafe attempt to initiate navigation|Failed to load resource/i;
test.use({ installed: INSTALLED, allowedErrors: [REFUSALS] });

const frameEl = (page: Page) => page.getByTestId("pages.frame");

async function pageOf(page: Page, prompt: string): Promise<void> {
  await configure();
  await start(page, prompt);
  await expect(page.locator(".turn.a.done")).toHaveCount(1, { timeout: 20_000 });
  await expect(frameEl(page)).toBeVisible();
}

test("the frame is a data: page sandboxed to scripts only, and sends no referrer", async ({ page, open }) => {
  await open(); await waitReady(page);
  await pageOf(page, LOAN_PROMPTS[0]);
  const attrs = await frameEl(page).evaluate((f: HTMLIFrameElement) => ({ sandbox: f.getAttribute("sandbox"), referrer: f.referrerPolicy, src: f.src.slice(0, 29), srcdoc: f.hasAttribute("srcdoc") }));
  expect(attrs).toEqual({ sandbox: "allow-scripts", referrer: "no-referrer", src: "data:text/html;charset=utf-8,", srcdoc: false });
});

test("a page learns nothing of the app and reaches nothing outside its frame", async ({ page, open }) => {
  await open(); await waitReady(page);
  await pageOf(page, PROBE_PROMPT);
  const out = page.frameLocator('[data-testid="pages.frame"]').locator("#out");
  await expect(out).not.toHaveText("running");
  const r = JSON.parse(await out.innerText()) as Record<string, unknown>;
  test.info().annotations.push({ type: "probe", description: JSON.stringify(r) });
  // the address: no referrer, a data: URL, nothing with the token in it
  expect.soft(r["referrer"]).toBe("");
  expect.soft(r["href"]).toBe("data:text/html;c");
  expect.soft(r["base"]).toBe("data:");
  // a word test would match the probe's own source, which its data: address holds
  expect.soft(JSON.stringify(r)).not.toContain(TOKEN);
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
  // WebRTC and popups
  expect.soft(r["rtc"]).toBe("undefined,undefined,undefined");
  expect.soft(r["popup"]).toBe("null");
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
  // the app document's own policy refuses any frame but a data: page
  const refused = await page.evaluate((origin) => new Promise<string>((done) => {
    document.addEventListener("securitypolicyviolation", (e) => done(e.effectiveDirective), { once: true });
    const f = document.createElement("iframe");
    f.src = `${origin}/`;
    document.body.append(f);
    setTimeout(() => { f.remove(); done("loaded"); }, 2000);
  }), WEB_ORIGIN);
  expect(refused).toBe("frame-src");
});

test("open in its own window: a blank window holding the same locked frame, cut from the app", async ({ page, open }) => {
  await open(); await waitReady(page);
  await pageOf(page, LOAN_PROMPTS[0]);
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.getByTestId("pages.panel.open-window").click()]);
  expect(popup.url()).toBe("about:blank");
  const inside = await popup.evaluate(() => {
    const f = document.querySelector("iframe");
    return { opener: window.opener === null, title: document.title, sandbox: f?.getAttribute("sandbox"), referrer: f?.referrerPolicy, src: f?.src.slice(0, 29) };
  });
  expect(inside).toEqual({ opener: true, title: "Loan calculator", sandbox: "allow-scripts", referrer: "no-referrer", src: "data:text/html;charset=utf-8," });
  await expect(popup.frameLocator("iframe").locator("#monthly")).toHaveText("$489.15");
  await popup.close();
});
