// Settings › General › Accent: the saved choice reaches the page root, a
// save sends only the accent, and Reset puts Neutral back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import { installBrowser, tick, until, type Browser } from "./harness.ts";

let b: Browser;
let session: typeof import("../src/session.ts");
let store: typeof import("../src/store.ts");
let disconnect: () => void;
const root = new Map<string, string>();
beforeEach(async () => {
  b = installBrowser(); vi.resetModules(); root.clear();
  vi.stubGlobal("document", { documentElement: { setAttribute: (k: string, v: string) => void root.set(k, v), removeAttribute: (k: string) => void root.delete(k) } });
  session = await import("../src/session.ts"); store = await import("../src/store.ts");
  disconnect = session.connect(); await until(() => store.getState().conn.kind === "open");
});
afterEach(async () => { disconnect(); b.server.accepting = false; for (const socket of b.server.sockets) socket.close(); await tick(); vi.unstubAllGlobals(); });

const base = methodSamples["settings.get"].result;

describe("Accent", () => {
  it("Neutral (unset or picked) leaves the root alone; a colour sets data-accent", async () => {
    expect(root.has("data-accent")).toBe(false);
    b.server.push("settings.changed", { ...base, accent: "blue" });
    await until(() => root.get("data-accent") === "blue", 2000, "blue on the root");
    b.server.push("settings.changed", { ...base, accent: "neutral" });
    await until(() => !root.has("data-accent"), 2000, "neutral clears the root");
  });

  it("a pick saves only the accent and applies what the server accepted", async () => {
    const held = b.server.hold("settings.update"), saving = session.updateSettings({ accent: "amber" }), call = await held;
    expect(call.params).toEqual({ accent: "amber" });
    call.respond({ ...base, accent: "amber" });
    expect(await saving).toBeNull();
    expect(root.get("data-accent")).toBe("amber");
  });

  it("Reset sends Neutral and the root goes back to the theme foreground", async () => {
    b.server.push("settings.changed", { ...base, accent: "red" });
    await until(() => root.get("data-accent") === "red", 2000, "red on the root");
    const held = b.server.hold("settings.update"), reset = session.resetSettings(), call = await held;
    expect(call.params).toMatchObject({ accent: "neutral" });
    call.respond({ ...base, accent: "neutral" });
    expect(await reset).toBeNull();
    expect(root.has("data-accent")).toBe(false);
  });
});
