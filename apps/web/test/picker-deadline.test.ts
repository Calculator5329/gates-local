// Real Picker, fit epochs and RPC deadlines; effect dependencies model one mount.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import { installBrowser, tick, until, type Browser } from "./harness.ts";

const effects = vi.hoisted(() => ({
  index: 0,
  slots: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  pending: [] as (() => void)[],
}));
function effect(run: () => void | (() => void), deps?: readonly unknown[]) {
  const index = effects.index++, previous = effects.slots.get(index);
  if (!deps || !previous?.deps || deps.length !== previous.deps.length || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) effects.pending.push(() => {
    previous?.cleanup?.();
    const cleanup = run();
    effects.slots.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
  });
}
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useEffect: effect, useLayoutEffect: effect }));
vi.mock("../src/store.ts", async original => {
  const actual = await original<typeof import("../src/store.ts")>();
  return { ...actual, useStore: <T>(select: (s: ReturnType<typeof actual.getState>) => T) => select(actual.getState()) };
});
vi.mock("../src/ui.tsx", async original => ({
  ...await original<typeof import("../src/ui.tsx")>(), useMedia: () => false, isTouch: () => false,
}));

let browser: Browser;
let session: typeof import("../src/session.ts");
let store: typeof import("../src/store.ts");
let Picker: typeof import("../src/Picker.tsx")["Picker"];
let disconnect: (() => void) | undefined;
let key: string;
beforeEach(async () => {
  browser = installBrowser(); vi.resetModules(); effects.index = 0; effects.slots.clear(); effects.pending.length = 0;
  vi.stubGlobal("document", { ...document, getElementById: () => null });
  browser.server.answer("fit.check", params => ({ ...methodSamples["fit.check"].result, ...params }));
  session = await import("../src/session.ts"); store = await import("../src/store.ts");
  Picker = (await import("../src/Picker.tsx")).Picker;
  disconnect = session.connect(); await until(() => store.getState().hydrationSettled); await tick();
  const model = store.getState().model, info = methodSamples["models.list"].result[0];
  if (!model || !info) throw new Error("Missing selected chat model");
  store.setState({ view: "new", numCtx: 8192, models: [{ ...info, name: model, capabilities: ["completion"], maxContext: 8192 }] });
  (await import("../src/picker-fit.ts")).warmPickerFits(); await tick();
  key = store.fitKey(model, 8192);
  expect(session.fitIsCurrent(store.getState().fits[key])).toBe(true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(async () => {
  for (const slot of effects.slots.values()) slot.cleanup?.();
  disconnect?.(); browser.server.accepting = false;
  for (const socket of browser.server.sockets) socket.close();
  await vi.advanceTimersByTimeAsync(0); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});
async function frame() {
  effects.index = 0; effects.pending.length = 0;
  const html = renderToStaticMarkup(createElement(Picker));
  for (const run of effects.pending.splice(0)) run();
  await vi.advanceTimersByTimeAsync(0);
  return html;
}
async function invalidate() {
  // Never respond: the real client's 30-second deadlines still run.
  const pending = browser.server.hold("fit.check");
  browser.server.push("gpu.changed", methodSamples["gpu.status"].result);
  await vi.advanceTimersByTimeAsync(0);
  await frame();
  return pending;
}

it("bounds first opening even when every three-second invalidation supersedes unanswered checks", async () => {
  const cached = store.getState().fits[key], before = browser.server.calls("fit.check").length;
  await invalidate(); store.setState({ pop: { id: "picker", kb: false } }); await frame();
  for (let seconds = 3; seconds <= 27; seconds += 3) {
    await vi.advanceTimersByTimeAsync(3000); await invalidate();
  }
  await vi.advanceTimersByTimeAsync(2999); await frame();
  expect(store.getState().pop).not.toMatchObject({ ready: true });
  await vi.advanceTimersByTimeAsync(1); await frame();
  expect.soft(store.getState().pop, "the first-view deadline must survive epoch changes").toMatchObject({ ready: true });
  await invalidate();
  for (let seconds = 33; seconds <= 90; seconds += 3) {
    await vi.advanceTimersByTimeAsync(3000); await invalidate();
  }
  const html = await frame();
  expect(store.getState().fits[key], "older timeout errors were discarded").toBe(cached);
  expect(session.fitIsCurrent(cached)).toBe(false);
  expect(browser.server.calls("fit.check").length - before, "one request per epoch, none from the deadline").toBe(31);
  expect(html).toContain('id="picker"');
  expect(html).toContain("Previous check");
  expect(html).toMatch(/class="pk-r[^"]*"[^>]*aria-busy="true"/);
});

it("opens on a current answer before the deadline, cancels its timer and adds no request", async () => {
  const before = browser.server.calls("fit.check").length;
  const held = await invalidate(); store.setState({ pop: { id: "picker", kb: false } }); await frame();
  await vi.advanceTimersByTimeAsync(100);
  held.respond({ ...methodSamples["fit.check"].result, ...held.params });
  await vi.advanceTimersByTimeAsync(0); await frame();
  expect(store.getState().pop).toMatchObject({ ready: true });
  const html = await frame();
  expect(html).toContain('id="picker"');
  expect(html).not.toContain("Previous check");
  expect(html).not.toContain("Checking…");
  expect(vi.getTimerCount()).toBe(0);
  expect(browser.server.calls("fit.check").length - before).toBe(1);
});

it("does not reopen a picker dismissed while its first view was pending", async () => {
  await invalidate(); store.setState({ pop: { id: "picker", kb: false } }); await frame();
  await vi.advanceTimersByTimeAsync(3000); await invalidate();
  store.setState({ pop: null }); await frame();
  await vi.advanceTimersByTimeAsync(27_000);
  expect(await frame()).not.toContain('id="picker"');
  expect(store.getState().pop).toBeNull();
});
