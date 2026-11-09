import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import { installBrowser, tick, until, type Browser } from "./harness.ts";

let b: Browser;
let session: typeof import("../src/session.ts");
let store: typeof import("../src/store.ts");
let disconnect: () => void;
beforeEach(async () => {
  b = installBrowser(); vi.resetModules();
  session = await import("../src/session.ts"); store = await import("../src/store.ts");
  disconnect = session.connect(); await until(() => store.getState().conn.kind === "open");
});
afterEach(async () => { disconnect(); b.server.accepting = false; for (const socket of b.server.sockets) socket.close(); await tick(); vi.unstubAllGlobals(); });

describe("Instructions actions", () => {
  it("Reset all clears shared and per-model settings in one update and preserves the runtime choice", async () => {
    store.setState({ settings: { ...methodSamples["settings.get"].result, systemPrompt: "shared", modelSettings: { "qwen3.5:9b": { systemPrompt: "custom", seed: 42 } } } });
    const held = b.server.hold("settings.update"), reset = session.resetSettings(), call = await held;
    expect(call.params).toMatchObject({ systemPrompt: null, modelSettings: null });
    expect(call.params).not.toHaveProperty("runtimeMode");
    call.respond(methodSamples["settings.get"].result);
    expect(await reset).toBeNull();
    expect(store.getState().settings).not.toHaveProperty("systemPrompt");
    expect(store.getState().settings).not.toHaveProperty("modelSettings");
  });
  it("model saves wait for the server and retain the old settings on failure", async () => {
    const original = methodSamples["settings.get"].result;
    store.setState({ settings: original });
    const held = b.server.hold("settings.model.update"), save = session.updateModelSettings("qwen3.5:9b", { seed: 42 }), call = await held;
    expect(store.getState().settings).toEqual(original);
    call.fail("disk-full", "No space left");
    expect(await save).toContain("No space left");
    expect(store.getState().settings).toEqual(original);
  });
  it("a successful per-model reset applies the server's settings without changing chat context", async () => {
    store.setState({ numCtx: 32768 });
    const held = b.server.hold("settings.model.update"), save = session.updateModelSettings("qwen3.5:9b", null), call = await held;
    expect(call.params).toEqual({ model: "qwen3.5:9b", patch: null });
    call.respond(methodSamples["settings.get"].result);
    expect(await save).toBeNull(); expect(store.getState().numCtx).toBe(32768);
  });
});
