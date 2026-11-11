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
  store.setState({ models: undefined, model: undefined, chosen: undefined, gpu: undefined, runtime: undefined, catalog: undefined, fitTable: undefined, pulls: {}, pop: null, numCtx: 16384, hydrationSettled: false });
  Picker = (await import("../src/Picker.tsx")).Picker;
  browser.server.answer("fit.table", () => { throw { code: "internal", message: "No fit reading" }; });
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
  expect(browser.server.calls("fit.table")).toHaveLength(0);
  expect(browser.server.calls("models.load")).toHaveLength(0);
});

it("opens unknown costs when the runtime is stopped", async () => {
  browser.server.answer("runtime.status", () => ({ ...methodSamples["runtime.status"].result, state: "stopped" }));
  disconnect = session.connect(); await vi.advanceTimersByTimeAsync(0);
  store.setState({ pop: { id: "picker", kb: false } });
  expect(await render()).toContain('id="picker"');
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
  expect(browser.server.calls("fit.table")).toHaveLength(0);
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

/** Connected, the runtime ready, the model list not in yet and the reads not settled: the picker's first view waits. */
const waitingForModels = () => store.setState({ conn: { kind: "open" }, runtime: { ...methodSamples["runtime.status"].result, state: "ready" }, models: undefined, hydrationSettled: false });
/** Whether the open picker has been marked ready to show. */
const pickerReady = () => { const pop = store.getState().pop; return pop?.id === "picker" ? pop.ready : undefined; };

it("the picker's first view waits for the model list, then shows", async () => {
  waitingForModels();
  store.setState({ pop: { id: "picker", kb: false } });
  expect(await render(), "nothing shows before the model list").not.toContain('id="picker"');
  expect(store.getState().pop).toMatchObject({ id: "picker" });
  expect(pickerReady()).toBeFalsy();
  store.setState({ models: [] });
  expect(await render()).toContain('id="picker"');
  expect(pickerReady()).toBe(true);
});

it("a picker dismissed before it was ready does not open when the model list lands", async () => {
  waitingForModels();
  store.setState({ pop: { id: "picker", kb: false } });
  await render();
  // the model list lands and that frame renders; the person dismisses the picker before its effects run
  store.setState({ models: [] });
  effects.length = 0;
  renderToStaticMarkup(createElement(Picker));
  store.setState({ pop: null });
  for (const run of effects.splice(0)) run();
  expect(store.getState().pop).toBeNull();
  expect(await render()).not.toContain('id="picker"');
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
        // The picker no longer waits for a GPU reading: fit values are a skeleton until the first table.
        if (method === "gpu.status") expect(pending).toContain("fit-skel");
        // The real protocol client's existing 30-second deadline, without a
        // new picker timer or a 30-second browser journey.
        await vi.advanceTimersByTimeAsync(30_000);
      }
      const html = await render();
      expect(html).toContain('id="picker"');
      expect(html).toContain("Download models");
      expect(store.getState().fitTable).toBeUndefined();
      expect(browser.server.calls("models.load")).toHaveLength(0);
    });
  }
}
