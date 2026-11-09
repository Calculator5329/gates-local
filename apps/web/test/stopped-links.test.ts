import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { State } from "../src/store.ts";
import { installBrowser, tick, until } from "./harness.ts";

vi.mock("../src/store.ts", async (original) => {
  const actual = await original<typeof import("../src/store.ts")>();
  return { ...actual, useStore: <T,>(selector: (s: State) => T) => selector(actual.getState()) };
});

it("keeps rendered link permissions after Stop followed by Send", async () => {
  const browser = installBrowser();
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const session = await import("../src/session.ts");
  const store = await import("../src/store.ts");
  const { Timeline } = await import("../src/Thread.tsx");
  const disconnect = session.connect();
  try {
    await until(() => store.getState().imageStatus !== undefined && store.getState().conn.kind === "open");
    await session.send("Draw a ship and read the report");
    const live = Object.values(store.getState().turns)[0]!;
    const event = (value: import("@gates-local/contracts").Payload<"chat.event">["event"]) => browser.server.push("chat.event", { turnId: live.turnId!, threadId: live.threadId, event: value });
    event({ type: "tool", step: { callId: "image", name: "image", state: "done", summary: "Image queued", links: [] } });
    event({ type: "tool", step: { callId: "read", name: "read", state: "done", summary: "Read report", links: ["https://tool.example/report"] } });
    event({ type: "delta", text: "[Download](https://invented.example/ship.png) and [Report](https://tool.example/report)" });
    await tick();
    browser.frame();
    const check = () => {
      const html = renderToStaticMarkup(createElement(Timeline, { threadId: live.threadId }));
      expect(html).toContain("Download");
      expect(html).not.toContain('href="https://invented.example/ship.png"');
      expect(html).toContain('href="https://tool.example/report"');
    };
    check();
    event({ type: "tool", step: { callId: "pending", name: "read", state: "running", summary: "Reading another source" } });
    await tick();
    session.stop();
    event({ type: "error", code: "cancelled", message: "cancelled" });
    await tick();
    check();
    await session.send("Read the next report");
    expect(browser.server.calls("chat.send")).toHaveLength(2);
    check();
    const retained = renderToStaticMarkup(createElement(Timeline, { threadId: live.threadId }));
    expect(retained).not.toContain("Read · running");
  } finally {
    disconnect();
    browser.server.accepting = false;
    for (const socket of browser.server.sockets) socket.close();
    await tick();
    vi.unstubAllGlobals();
  }
});
