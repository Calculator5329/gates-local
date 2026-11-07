import { describe, expect, it } from "vitest";
import { dataUrl, renderStatusPage } from "../src/status-page.ts";

describe("status page", () => {
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
