// Exercise the surviving Settings GPU surface and real fit RPCs without a DOM.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import type { State } from "../src/store.ts";
import { type Browser, installBrowser, tick, until } from "./harness.ts";

const effects = vi.hoisted(() => ({ deps: undefined as readonly unknown[] | undefined, pending: undefined as (() => void) | undefined }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: (run: () => void, deps: readonly unknown[]) => {
    if (!effects.deps || deps.some((value, index) => !Object.is(value, effects.deps?.[index]))) effects.pending = run;
    effects.deps = deps;
  },
}));
vi.mock("../src/store.ts", async (original) => {
  const actual = await original<typeof import("../src/store.ts")>();
  return { ...actual, useStore: <T>(select: (state: State) => T) => select(actual.getState()) };
});
vi.mock("../src/ui.tsx", async (original) => ({
  ...await original<typeof import("../src/ui.tsx")>(),
  closeTip: vi.fn(),
}));

let b: Browser;
let session: typeof import("../src/session.ts");
let store: typeof import("../src/store.ts");
let GpuMemory: typeof import("../src/FitPanel.tsx")["GpuMemory"];
let disconnect: (() => void) | undefined;
const contexts = [8192, 16384, 32768, 65536];
const report = methodSamples["fit.check"].result;
const model = report.model;
const button = (html: string, numCtx: number) => html.match(new RegExp('<button[^>]*data-ctx="' + numCtx + '"[^>]*>'))?.[0] ?? "";
const details = (html: string) => html.match(/<details class="upd-more fp-more">[\s\S]*?<\/details>/)?.[0] ?? "";
const render = () => {
  const html = renderToStaticMarkup(createElement(GpuMemory));
  const run = effects.pending;
  effects.pending = undefined;
  run?.();
  return html;
};

beforeEach(async () => {
  b = installBrowser();
  vi.resetModules();
  effects.deps = undefined;
  effects.pending = undefined;
  session = await import("../src/session.ts");
  store = await import("../src/store.ts");
  GpuMemory = (await import("../src/FitPanel.tsx")).GpuMemory;
  disconnect = session.connect();
  await until(() => store.getState().imageStatus !== undefined);
  await tick();
  const settings = store.getState().settings;
  if (!settings || settings === "na") throw new Error("Settings did not hydrate");
  store.setState({
    model, numCtx: 32768, fitPanel: { model: null }, settings: { ...settings, defaultNumCtx: 32768 },
    models: [{ ...methodSamples["models.list"].result[0]!, name: model, maxContext: 65536 }],
  });
  b.server.answer("fit.check", ({ numCtx }) => ({ ...report, numCtx, verdict: "fits" }));
  render();
  await until(() => contexts.every((ctx) => store.getState().fits[store.fitKey(model, ctx)] !== undefined));
});
afterEach(async () => {
  disconnect?.();
  b.server.accepting = false;
  for (const socket of b.server.sockets) socket.close();
  await tick(10);
  vi.unstubAllGlobals();
});

it("Settings rechecks both contexts on separate invalidation and keeps the verdict footprint while Checking", async () => {
  const before = render();
  expect(button(before, 32768)).toContain('data-tip="Runs on the GPU at 32k.');
  expect(button(before, 65536)).toContain('data-tip="Runs on the GPU at 64k.');
  expect(details(before)).toContain("Runs entirely on the GPU.");
  const retained = store.getState().fits;
  const closeTip = vi.mocked((await import("../src/ui.tsx")).closeTip);
  closeTip.mockClear();
  const count = b.server.calls("fit.check").length;
  const replies = contexts.map(() => b.server.hold("fit.check"));
  b.server.push("gpu.changed", methodSamples["gpu.status"].result);
  // The invalidation signal must work even when all retained report identities stay put.
  store.setState({ fits: retained });
  const pending = render();
  expect(closeTip, "an already-open tooltip must not retain its copied fit advice").toHaveBeenCalledOnce();
  expect(button(pending, 32768)).toContain('data-tip="Checking…');
  expect(button(pending, 65536)).toContain('data-tip="Checking…');
  expect(pending).toContain('aria-busy="true"');
  expect(pending).toContain('aria-hidden="true" style="visibility:hidden"><div class="fp-v">');
  expect(pending).toContain('inert="" aria-hidden="true" style="visibility:hidden"><div class="fp-v">');
  expect(pending).toContain('style="position:absolute;inset:0"');
  const pendingDetails = details(pending);
  expect(pendingDetails).toContain("<summary>Details</summary>");
  // Static markup retains hidden and closed content: check the actual stale-content wrapper.
  expect(pendingDetails).toContain('aria-busy="true" style="position:relative"');
  expect(pendingDetails).toContain('aria-hidden="true" style="visibility:hidden"><div class="fp-n">');
  expect(pendingDetails).toContain('inert="" aria-hidden="true" style="visibility:hidden"><div class="fp-n">');
  expect(pendingDetails).toContain('style="position:absolute;inset:0">Checking GPU memory…');
  await tick();
  expect(b.server.calls("fit.check").slice(count)).toHaveLength(contexts.length);
  const held = await Promise.all(replies);
  expect(held.map((reply) => reply.params.numCtx).toSorted((a, z) => a - z)).toEqual(contexts);
  for (const reply of held) reply.respond({ ...report, numCtx: reply.params.numCtx, verdict: "refuse", needVramBytes: report.freeVramBytes + 1024 ** 3 });
  await tick();
  const refreshed = render();
  expect(button(refreshed, 65536)).toMatch(/data-tip="Won(?:&#x27;|')t fit at 64k:/);
  expect(refreshed).toContain("Needs ");
  expect(refreshed).not.toContain("Checking…");
  expect(refreshed).not.toContain("ctx-def");
  expect(details(refreshed)).toContain("<summary>Details</summary>");
  expect(details(refreshed)).not.toContain('<div aria-hidden="true" style="visibility:hidden">');
});
