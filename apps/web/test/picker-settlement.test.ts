// Real connection deadlines and real Picker rendering, over the in-memory wire.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import { installBrowser, type Browser } from "./harness.ts";

const effects = vi.hoisted(() => [] as (() => void)[]);
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useEffect: (run: () => void) => { effects.push(run); },
  useLayoutEffect: (run: () => void) => { effects.push(run); },
}));
vi.mock("../src/store.ts", async original => {
  const actual = await original<typeof import("../src/store.ts")>();
  return { ...actual, useStore: <T>(select: (s: ReturnType<typeof actual.getState>) => T) => select(actual.getState()) };
});

let browser: Browser;
let session: typeof import("../src/session.ts");
let store: typeof import("../src/store.ts");
let Picker: typeof import("../src/Picker.tsx")["Picker"];
let disconnect: (() => void) | undefined;
beforeEach(async () => {
  browser = installBrowser(); vi.resetModules(); effects.length = 0;
  disconnect = undefined;
  vi.stubGlobal("document", { ...document, getElementById: () => null });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  session = await import("../src/session.ts");
  store = await import("../src/store.ts");
  store.setState({ models: undefined, model: undefined, chosen: undefined, gpu: undefined, runtime: undefined, catalog: undefined, fits: {}, fitStatus: {}, fitHistory: {}, pulls: {}, pop: null, numCtx: 16384, hydrationSettled: false });
  Picker = (await import("../src/Picker.tsx")).Picker;
  browser.server.answer("fit.check", () => { throw { code: "internal", message: "No fit reading" }; });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(async () => {
  disconnect?.(); browser.server.accepting = false;
  for (const socket of browser.server.sockets) socket.close();
  await vi.advanceTimersByTimeAsync(500);
  vi.useRealTimers(); vi.unstubAllGlobals();
});

async function render() {
  let html = "";
  for (let frame = 0; frame < 3; frame++) {
    effects.length = 0;
    html = renderToStaticMarkup(createElement(Picker));
    for (const run of effects.splice(0)) run();
    await vi.advanceTimersByTimeAsync(0);
  }
  return html;
}

it("opens unknown state before any connection can start the initial reads", async () => {
  store.setState({ conn: { kind: "connecting" }, pop: { id: "picker", kb: false } });
  expect(await render()).toContain('id="picker"');
  expect(browser.server.calls("fit.check")).toHaveLength(0);
  expect(browser.server.calls("models.load")).toHaveLength(0);
});

it("opens unknown costs when the runtime cannot start any fit requests", async () => {
  browser.server.answer("runtime.status", () => ({ ...methodSamples["runtime.status"].result, state: "stopped" }));
  disconnect = session.connect(); await vi.advanceTimersByTimeAsync(0);
  store.setState({ pop: { id: "picker", kb: false } });
  expect(await render()).toContain('id="picker"');
  expect(browser.server.calls("fit.check")).toHaveLength(0);
  expect(browser.server.calls("models.load")).toHaveLength(0);
});

it("does not settle failed startup before negotiation authorizes the initial reads", async () => {
  const pending = browser.server.hold("sync.negotiate");
  disconnect = session.connect();
  const negotiation = await pending;
  await vi.advanceTimersByTimeAsync(0);
  expect(store.getState().hydrationSettled).toBe(false);
  expect(browser.server.calls("models.list")).toHaveLength(0);
  expect(browser.server.calls("gpu.status")).toHaveLength(0);
  expect(browser.server.calls("fit.check")).toHaveLength(0);
  negotiation.fail("internal", "Negotiation refused");
  await vi.advanceTimersByTimeAsync(0);
  expect(store.getState().conn.kind).toBe("down");
  expect(store.getState().hydrationSettled).toBe(false);
});

it("does not let a closed connection settle preparation during the next connection's held reads", async () => {
  const firstRead = browser.server.hold("gpu.status");
  disconnect = session.connect();
  const previous = await firstRead;
  browser.server.socket.close();
  await vi.advanceTimersByTimeAsync(0);
  expect(store.getState().conn.kind).toBe("down");
  expect(store.getState().hydrationSettled).toBe(false);
  const nextNegotiation = browser.server.hold("sync.negotiate");
  const nextRead = browser.server.hold("gpu.status");
  await vi.advanceTimersByTimeAsync(250);
  const negotiation = await nextNegotiation;
  expect(store.getState().hydrationSettled).toBe(false);
  negotiation.respond(methodSamples["sync.negotiate"].result);
  const current = await nextRead;
  previous.respond(methodSamples["gpu.status"].result);
  await vi.advanceTimersByTimeAsync(0);
  expect(store.getState().hydrationSettled).toBe(false);
  current.respond(methodSamples["gpu.status"].result);
  await vi.advanceTimersByTimeAsync(0);
  expect(store.getState().hydrationSettled).toBe(true);
});

for (const method of ["gpu.status", "models.list"] as const) {
  for (const ending of ["error", "timeout"] as const) {
    it(`opens a usable picker after ${method} settles with ${ending}, without a current fit`, async () => {
      if (ending === "error") browser.server.answer(method, () => { throw { code: "internal", message: "No reading" }; });
      const held = ending === "timeout" ? browser.server.hold(method) : undefined;
      disconnect = session.connect();
      if (held) await held;
      await vi.advanceTimersByTimeAsync(0);
      store.setState({ pop: { id: "picker", kb: false } });
      if (held) {
        const pending = await render();
        if (method === "gpu.status") expect(pending).not.toContain('id="picker"');
        // The real protocol client's existing 30-second deadline, without a
        // new picker timer or a 30-second browser journey.
        await vi.advanceTimersByTimeAsync(30_000);
      }
      const html = await render();
      expect(html).toContain('id="picker"');
      expect(html).toContain("Download models");
      expect(Object.values(store.getState().fits).some(session.fitIsCurrent)).toBe(false);
      expect(browser.server.calls("models.load")).toHaveLength(0);
    });
  }
}
