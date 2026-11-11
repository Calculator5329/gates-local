import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { dataUrl, renderStatusPage } from "../src/status-page.ts";

type Listener = () => Promise<void> | void;

/** Runs the page's own script against a fake document holding its buttons, so a click reaches the bridge as it would in the window. */
function load(html: string, bridge: Record<string, () => Promise<unknown>>) {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (script === undefined) throw new Error("Expected the page script");
  const status = { textContent: "" };
  const buttons = [...html.matchAll(/<button data-action="(\w+)">([^<]*)<\/button>/g)].map(([, action, label]) => {
    const listeners = new Map<string, Listener[]>();
    return {
      label, dataset: { action }, disabled: false,
      addEventListener: (type: string, fn: Listener) => { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
      click: () => Promise.all((listeners.get("click") ?? []).map(fn => fn())),
    };
  });
  runInNewContext(script, {
    document: { querySelectorAll: () => buttons, getElementById: (id: string) => id === "action-status" ? status : null },
    window: { gatesLocal: bridge },
  });
  const button = (label: string) => {
    const found = buttons.find(b => b.label === label);
    if (!found) throw new Error(`Expected a ${label} button`);
    return found;
  };
  return { button, status };
}

describe("status page", () => {
  it("keeps a draggable header clear of native controls (TB-01)", () => {
    // Every view goes through one page template, so one view covers them all.
    const html = renderStatusPage({ kind: "server", state: { status: "starting", launch: 1 } });
    expect(html).toContain('<header class="titlebar">Gates Local</header>');
    const header = /\.titlebar\{([^}]+)\}/.exec(html)?.[1];
    expect(header).toContain("-webkit-app-region:drag");
    expect(header).toContain("env(titlebar-area-height,52px)");
    expect(header).toContain("env(titlebar-area-x,0px)");
    expect(header).toContain("env(titlebar-area-width,");
    expect(html).toMatch(/<main>[\s\S]*<h1>[\s\S]*<\/main>/);
  });

  it("shows the exit reason and escaped stderr, and its Restart and Open data folder buttons call the bridge", async () => {
    const html = renderStatusPage({
      kind: "server",
      state: {
        status: "crashed",
        launch: 1,
        reason: { kind: "exit", code: null, signal: "SIGKILL" },
        stderrTail: ["<script>alert(1)</script>"],
        logPath: "data/server-failure-<example>.json",
        restartBlockedUntil: null,
      },
    });
    expect(html).toContain("killed by SIGKILL");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("server-failure-&lt;example&gt;.json");
    const bridge = {
      restart: vi.fn(async () => ({ ok: false, reason: "rate-limited", retryAfterMs: 4_500 })),
      openDataFolder: vi.fn(async () => "data"),
    };
    const page = load(html, bridge);
    await page.button("Open data folder").click();
    expect(bridge.openDataFolder).toHaveBeenCalledTimes(1);
    expect(bridge.restart).not.toHaveBeenCalled();
    const restart = page.button("Restart");
    await restart.click();
    expect(bridge.restart).toHaveBeenCalledTimes(1);
    expect(page.status.textContent).toBe("Restarted too often; try again in 5 s.");
    expect(restart.disabled).toBe(false);
  });

  it("says when the restart guard is holding Restart back", () => {
    const html = renderStatusPage({
      kind: "server",
      state: { status: "crashed", launch: 4, reason: { kind: "exit", code: 1, signal: null }, stderrTail: [], restartBlockedUntil: Date.now() + 30_000 },
    });
    expect(html).toContain("exited with code 1");
    expect(html).toContain("Restart opens again at");
  });

  it("offers a reload that calls the bridge when the web client failed to load", async () => {
    const html = renderStatusPage({ kind: "client-load-failed", url: "http://127.0.0.1:5187/", error: "ERR_CONNECTION_REFUSED" });
    const bridge = { reloadClient: vi.fn(async () => undefined) };
    await load(html, bridge).button("Try again").click();
    expect(bridge.reloadClient).toHaveBeenCalledTimes(1);
    expect(decodeURIComponent(dataUrl(html).slice("data:text/html;charset=utf-8,".length))).toBe(html);
  });
});
