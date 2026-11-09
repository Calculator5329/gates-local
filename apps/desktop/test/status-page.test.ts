import { describe, expect, it } from "vitest";
import { dataUrl, renderStatusPage, type StatusView } from "../src/status-page.ts";

describe("status page", () => {
  const views: StatusView[] = [
    { kind: "server", state: { status: "starting", launch: 1 } },
    { kind: "server", state: { status: "restarting", launch: 2 } },
    { kind: "server", state: { status: "crashed", launch: 1, reason: { kind: "exit", code: 1, signal: null }, stderrTail: [], restartBlockedUntil: null } },
    { kind: "client-load-failed", url: "gates-local://app/index.html", error: "ERR_FAILED" },
  ];
  it.each(views)("keeps a draggable header clear of native controls for $kind $state.status (TB-01)", (view) => {
    const html = renderStatusPage(view);
    expect(html).toContain('<header class="titlebar">Gates Local</header>');
    const header = /\.titlebar\{([^}]+)\}/.exec(html)?.[1];
    expect(header).toContain("-webkit-app-region:drag");
    expect(header).toContain("env(titlebar-area-height,52px)");
    expect(header).toContain("env(titlebar-area-x,0px)");
    expect(header).toContain("env(titlebar-area-width,");
    expect(html).toMatch(/<main>[\s\S]*<h1>[\s\S]*<\/main>/);
  });

  it("shows the exit reason, escaped stderr and a Restart button wired to the bridge", () => {
    const html = renderStatusPage({
      kind: "server",
      state: {
        status: "crashed",
        launch: 1,
        reason: { kind: "exit", code: null, signal: "SIGKILL" },
        stderrTail: ["<script>alert(1)</script>"],
        restartBlockedUntil: null,
      },
    });
    expect(html).toContain("killed by SIGKILL");
    expect(html).toContain('<button data-action="restart">Restart</button>');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("window.gatesLocal[button.dataset.action]");
  });

  it("says when the restart guard is holding Restart back", () => {
    const html = renderStatusPage({
      kind: "server",
      state: { status: "crashed", launch: 4, reason: { kind: "exit", code: 1, signal: null }, stderrTail: [], restartBlockedUntil: Date.now() + 30_000 },
    });
    expect(html).toContain("exited with code 1");
    expect(html).toContain("Restart opens again at");
  });

  it("offers a reload when the web client failed to load", () => {
    const html = renderStatusPage({ kind: "client-load-failed", url: "http://127.0.0.1:5187/", error: "ERR_CONNECTION_REFUSED" });
    expect(html).toContain('data-action="reloadClient"');
    expect(decodeURIComponent(dataUrl(html).slice("data:text/html;charset=utf-8,".length))).toBe(html);
  });
});
