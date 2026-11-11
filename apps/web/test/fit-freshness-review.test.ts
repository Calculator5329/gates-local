// Render the actual fit consumers and run their changed effects over the in-memory server.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import type { State } from "../src/store.ts";
import { type Browser, installBrowser, tick, until } from "./harness.ts";

// With `mounted` set, useState and useRef keep their values from one render to
// the next, by call order, as a mounted component's do.
const effects = vi.hoisted(() => {
  const hooks = {
    index: 0, deps: new Map<number, readonly unknown[]>(), pending: [] as (() => void)[], mounted: false, slot: 0, slots: new Map<number, { current: unknown }>(),
    take: (init: () => unknown): { current: unknown } => {
      const i = hooks.slot++;
      if (!hooks.slots.has(i)) hooks.slots.set(i, { current: init() });
      return hooks.slots.get(i)!;
    },
  };
  return hooks;
});
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useEffect: (run: () => void, deps: readonly unknown[]) => {
      const index = effects.index++;
      const old = effects.deps.get(index);
      if (!old || deps.some((value, i) => !Object.is(value, old[i]))) effects.pending.push(run);
      effects.deps.set(index, deps);
    },
    useRef: (init: unknown) => effects.mounted ? effects.take(() => init) : react.useRef(init),
    useState: (init: unknown) => {
      if (!effects.mounted) return react.useState(init);
      const s = effects.take(() => typeof init === "function" ? (init as () => unknown)() : init);
      return [s.current, (v: unknown) => { s.current = typeof v === "function" ? (v as (x: unknown) => unknown)(s.current) : v; }];
    },
  };
});
vi.mock("../src/store.ts", async original => {
  const actual = await original<typeof import("../src/store.ts")>();
  return { ...actual, useStore: <T>(select: (state: State) => T) => select(actual.getState()) };
});

let b: Browser;
let session: typeof import("../src/session.ts");
let store: typeof import("../src/store.ts");
let views: Record<string, React.ComponentType>;
let disconnect: (() => void) | undefined;
const report = methodSamples["fit.check"].result;
const model = report.model;
const installed = { ...methodSamples["models.list"].result[0]!, name: model, capabilities: ["completion" as const], maxContext: 65536 };
const entry = { name: model, label: "Test model", purpose: "Chat", recommended: true, installed: false, downloadBytes: 100, fit: { ...report, verdict: "fits" as const } };
const render = (view: string) => {
  effects.index = 0; effects.slot = 0;
  const html = renderToStaticMarkup(createElement(views[view]!));
  for (const run of effects.pending.splice(0)) run();
  return html.replaceAll("&#x27;", "'");
};
beforeEach(async () => {
  b = installBrowser();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  effects.deps.clear(); effects.pending = []; effects.mounted = false; effects.slots.clear();
  vi.resetModules();
  session = await import("../src/session.ts");
  store = await import("../src/store.ts");
  views = { settings: (await import("../src/FitPanel.tsx")).GpuMemory, models: (await import("../src/Models.tsx")).ModelsPage, picker: (await import("../src/Picker.tsx")).Picker, first: (await import("../src/FirstRun.tsx")).FirstRun };
  b.server.answer("fit.check", ({ model: tag, numCtx }) => ({ ...report, model: tag, numCtx, verdict: "fits" }));
  disconnect = session.connect();
  await until(() => store.getState().imageStatus !== undefined);
  await tick();
  store.setState({ models: [installed], model, catalog: [entry], numCtx: 16384, pop: { id: "picker", kb: false, ready: true }, settings: { ...methodSamples["settings.get"].result, defaultNumCtx: 16384 } });
});
afterEach(async () => {
  disconnect?.();
  b.server.accepting = false;
  for (const socket of b.server.sockets) socket.close();
  await tick();
  vi.unstubAllGlobals();
});

for (const view of ["settings", "models", "picker"]) {
  it(`SR-01: ${view} retains historical numbers but withdraws a positive fit during refresh and failure`, async () => {
    render(view);
    await until(() => store.getState().fits[store.fitKey(model, 16384)] !== undefined);
    await tick();
    const shown = (html: string) => view === "picker" ? html.match(/<button[^>]*data-ctx="16384"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "" : html;
    const positive = view === "picker" ? />Fits</ : /(?:Runs|Should run) well/;
    expect(shown(render(view))).toMatch(positive);
    if (view === "settings") expect(render(view)).toMatch(/>Estimated [\d.]+\sGB; [\d.]+\sGB available on GPU\./);
    const previous = store.getState().fits[store.fitKey(model, 16384)];
    const refresh = b.server.hold("fit.check");
    b.server.push("gpu.changed", { ...methodSamples["gpu.status"].result, freeBytes: 0 });
    const pending = render(view);
    expect(shown(pending)).not.toMatch(positive);
    expect(shown(pending)).toContain(view === "picker" ? "Previous check" : "Rechecking");
    expect(store.getState().fits[store.fitKey(model, 16384)]).toBe(previous);
    (await refresh).fail("unavailable", "cannot measure");
    await tick();
    const failed = render(view);
    expect(shown(failed)).not.toMatch(positive);
    expect(shown(failed)).toContain("Couldn't check");
    expect(store.getState().fitHistory[store.fitKey(model, 16384)]).toBe(previous);
    expect(session.fitIsCurrent(store.getState().fits[store.fitKey(model, 16384)])).toBe(false);
  });
}

it("PL-03: a held retry keeps Couldn't check visible until it succeeds", async () => {
  render("settings");
  const key = store.fitKey(model, 16384);
  await until(() => store.getState().fits[key] !== undefined);
  await tick();
  const first = b.server.hold("fit.check");
  b.server.push("gpu.changed", { ...methodSamples["gpu.status"].result, freeBytes: 0 });
  const held = await first;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    held.fail("unavailable", "cannot measure");
    await vi.advanceTimersByTimeAsync(0);
    expect(render("settings")).toContain("Couldn't check");
    await vi.advanceTimersByTimeAsync(0);
    const changedMemory = b.server.hold("fit.check");
    b.server.push("gpu.changed", { ...methodSamples["gpu.status"].result, freeBytes: 1 });
    expect(render("settings")).toContain("Rechecking");
    const changed = await changedMemory;
    expect(changed.params).toEqual({ model, numCtx: 16384 });
    changed.fail("unavailable", "still unavailable");
    await vi.advanceTimersByTimeAsync(0);
    const retry = b.server.hold("fit.check");
    await vi.advanceTimersByTimeAsync(2000);
    const pending = await retry;
    expect(render("settings")).toContain("Couldn't check");
    expect(render("settings")).not.toContain("Rechecking");
    pending.respond({ ...report, model, numCtx: 16384, verdict: "fits" });
    await vi.advanceTimersByTimeAsync(0);
    expect(render("settings")).toMatch(/(?:Runs|Should run) well/);
  } finally {
    vi.useRealTimers();
  }
});

it("SR-02: Settings refreshes the displayed requested 16k key for an 8k-capped model without a manual ensureFit", async () => {
  store.setState({ models: [{ ...installed, maxContext: 8192 }], numCtx: 16384 });
  render("settings");
  await until(() => store.getState().fits[store.fitKey(model, 16384)] !== undefined);
  await tick();
  render("settings");
  const calls = b.server.calls("fit.check").length;
  b.server.push("gpu.changed", { ...methodSamples["gpu.status"].result, freeBytes: 0 });
  render("settings");
  await tick();
  expect(b.server.calls("fit.check").slice(calls).some(call => (call.params as { numCtx: number }).numCtx === 16384)).toBe(true);
});

for (const have of [false, true]) {
  it(`SR-03: first run uses the refreshed refusal instead of ${have ? "the installed pick" : "the catalog promise"}`, async () => {
    // one mounted screen, so what it held from the earlier answer is still there
    effects.mounted = true;
    store.setState({ models: have ? [{ ...installed, pick: { verdict: "fits", numCtx: 16384 } }] : [], model: have ? model : undefined });
    render("first");
    await tick();
    render("first");
    const settled = render("first");
    expect(settled, "the screen is past its loading placeholders").not.toContain("fr-skel");
    expect(settled).toContain(have ? "Ready to chat" : "Download your first model");
    expect(settled).toContain("Runs on GPU");
    b.server.answer("fit.check", ({ model: tag, numCtx }) => ({ ...report, model: tag, numCtx, verdict: "refuse", freeVramBytes: 0, shortfallBytes: report.needVramBytes }));
    const calls = b.server.calls("fit.check").length;
    b.server.push("gpu.changed", { ...methodSamples["gpu.status"].result, freeBytes: 0 });
    const pending = render("first");
    // memory changed: the old answer is withdrawn while the new one is measured
    expect(pending).not.toContain("fr-skel");
    expect(pending).not.toContain("Ready to chat");
    expect(pending).not.toContain("Runs on GPU");
    expect(pending).toContain("Rechecking…");
    await tick();
    expect(b.server.calls("fit.check").length, "uninstalled recommendations also refresh").toBeGreaterThan(calls);
    const html = render("first");
    expect(html).not.toContain("Ready to chat");
    expect(html).not.toContain("Runs on GPU");
    expect(html).toContain(have ? "doesn't fit at 16k" : "Not enough memory");
  });
}
