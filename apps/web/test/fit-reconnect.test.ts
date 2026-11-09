// Real session/store and memory panel over the in-memory wire, with a held reconnect.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import type { State } from "../src/store.ts";
import { type Held, installBrowser, tick, until } from "./harness.ts";

const report = methodSamples["fit.check"].result;

it("TL-03: reconnect hides an old fits verdict during held hydration and rechecks the open chat afterwards", async () => {
  const b = installBrowser();
  vi.resetModules();
  const session = await import("../src/session.ts");
  const store = await import("../src/store.ts");
  const { getState, setState, fitKey } = store;
  vi.spyOn(store, "useStore").mockImplementation(<T>(select: (s: State) => T): T => select(getState()));
  const { GpuMemory } = await import("../src/FitPanel.tsx");
  // The hidden verdict reserves its footprint; it is not visible advice.
  const text = () => renderToStaticMarkup(createElement(GpuMemory)).replace(/<div(?=[^>]*aria-hidden="true")[^>]*>[\s\S]*?<\/div><\/div>/g, "").replace(/<[^>]*>/g, " ");
  b.server.answer("fit.check", ({ model, numCtx }) => ({ ...report, model, numCtx, verdict: "fits" }));
  setState({ imageStatus: undefined });
  const disconnect = session.connect();
  try {
    await until(() => getState().imageStatus !== undefined);
    const { model, numCtx } = getState();
    if (model === undefined) throw new Error("fixture has no chat model");
    const key = fitKey(model, numCtx);
    session.ensureFit(model, numCtx);
    await until(() => getState().fits[key] !== undefined);
    const cached = getState().fits[key];
    expect(text()).toContain("Runs well");

    const hydration = b.server.hold("models.list");
    let atReady: Held<"fit.check"> | undefined;
    void b.server.hold("fit.check").then(held => { atReady = held; });
    setState({ imageStatus: undefined });
    b.server.socket.close();
    await until(() => getState().conn.kind === "down");
    const models = await hydration;
    expect(getState().conn.kind).toBe("open");
    // Composer runs this at the ready flip; its fit dependency is still the cached object.
    session.ensureFit(model, numCtx);
    await tick();
    expect.soft(text()).toContain("Rechecking");
    expect.soft(text()).not.toContain("Runs well");
    expect(getState().fits[key]).toBe(cached); // the picker may retain its previous report

    let afterHydration: Held<"fit.check"> | undefined;
    void b.server.hold("fit.check").then(held => { afterHydration = held; });
    models.respond(methodSamples["models.list"].result);
    await until(() => getState().imageStatus !== undefined);
    await tick();
    expect(afterHydration, "hydration must recheck even when the fit object did not change").toBeDefined();
    if (afterHydration === undefined) return;
    expect(afterHydration.params).toEqual({ model, numCtx });
    // The ready-flip check belongs to the older epoch and cannot publish after hydration.
    atReady?.respond({ ...report, model, numCtx, verdict: "fits" });
    await tick();
    expect(text()).toContain("Rechecking");
    expect(getState().fits[key]).toBe(cached);
    afterHydration.respond({ ...report, model, numCtx, verdict: "refuse" });
    await until(() => {
      const r = getState().fits[key];
      return r !== undefined && r !== "error" && r.verdict === "refuse";
    });
    expect(text()).not.toContain("Runs well");
    expect(text()).not.toContain("Rechecking");
  } finally {
    disconnect();
    b.server.accepting = false;
    for (const socket of b.server.sockets) socket.close();
    await tick();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
