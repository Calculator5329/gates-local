import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import type { State } from "../src/store.ts";
import { installBrowser, tick, until } from "./harness.ts";

vi.mock("../src/store.ts", async (original) => {
  const actual = await original<typeof import("../src/store.ts")>();
  return { ...actual, useStore: <T>(selector: (s: State) => T) => selector(actual.getState()) };
});
import { fitKey, getState, setState } from "../src/store.ts";

const report = methodSamples["fit.check"].result;
let GpuMemory: typeof import("../src/FitPanel.tsx")["GpuMemory"];
const html = () => renderToStaticMarkup(createElement(GpuMemory));
const text = () => html().replace(/<div(?=[^>]*aria-hidden="true")[^>]*>[\s\S]*?<\/div><\/div>/g, "").replace(/<[^>]*>/g, " ").replaceAll("&#x27;", "'");

beforeAll(async () => {
  vi.stubGlobal("window", {});
  GpuMemory = (await import("../src/FitPanel.tsx")).GpuMemory;
});
beforeEach(() => {
  vi.stubGlobal("window", {});
  setState({
    conn: { kind: "open" }, runtime: methodSamples["runtime.status"].result,
    model: report.model, numCtx: 65536, models: [{ ...methodSamples["models.list"].result[0]!, name: report.model }],
    settings: { ...methodSamples["settings.get"].result, defaultNumCtx: 16384 },
    fitPanel: { model: null }, gpu: methodSamples["gpu.status"].result,
    fits: { [fitKey(report.model, 16384)]: { ...report, numCtx: 16384, verdict: "fits" } },
  });
});
afterEach(() => vi.unstubAllGlobals());

it("describes the selected chat's 64k breakdown while the saved default stays 16k", () => {
  setState(s => ({ fits: { ...s.fits, [fitKey(report.model, 65536)]: { ...report, numCtx: 65536, verdict: "refuse", needVramBytes: report.freeVramBytes + 1024 ** 3 } } }));
  expect(text()).toContain("Memory at 64k context");
  expect(text()).toContain("Needs");
  expect(text()).toContain("more at 64k");
  expect(text()).toContain("needs an estimated");
  expect(html()).toMatch(/data-ctx="16384"[^>]*aria-pressed="true"/);
  expect(getState().settings).toMatchObject({ defaultNumCtx: 16384 });
});

it("does not borrow the saved default's fits verdict while the selected size is pending or failed", () => {
  expect(text()).toContain("Checking GPU memory");
  setState(s => ({ fits: { ...s.fits, [fitKey(report.model, 65536)]: "error" } }));
  expect(text()).toContain("couldn't check GPU memory");
  expect(text()).not.toContain("Runs on GPU");
});

it("labels the clamped size that will actually be sent", () => {
  setState(s => ({ models: s.models?.map(m => ({ ...m, maxContext: 32768 })), fits: { [fitKey(report.model, 65536)]: { ...report, numCtx: 32768 } } }));
  expect(text()).toContain("Memory at 32k context");
  expect(text()).not.toContain("Memory at 64k context");
});

it("withholds a previous fits verdict while free memory is being checked again", async () => {
  const b = installBrowser();
  const session = await import("../src/session.ts");
  b.server.answer("fit.check", ({ numCtx }) => ({ ...report, numCtx, verdict: "fits" }));
  const disconnect = session.connect();
  try {
    await until(() => getState().imageStatus !== undefined);
    setState({ model: report.model, numCtx: 65536, fits: {}, settings: { ...methodSamples["settings.get"].result, defaultNumCtx: 65536 } });
    session.ensureFit(report.model, 65536);
    await until(() => getState().fits[fitKey(report.model, 65536)] !== undefined);
    expect(text()).toContain("Runs on GPU");
    const next = b.server.hold("fit.check");
    b.server.push("gpu.changed", methodSamples["gpu.status"].result);
    const held = await next;
    expect(text()).toContain("Checking GPU memory");
    expect(text()).not.toContain("Runs on GPU");
    held.respond({ ...report, numCtx: 65536, verdict: "refuse" });
    await until(() => {
      const r = getState().fits[fitKey(report.model, 65536)];
      return r !== undefined && r !== "error" && r.verdict === "refuse";
    });
    expect(text()).toContain("more at 64k");
  } finally {
    disconnect();
    b.server.accepting = false;
    for (const socket of b.server.sockets) socket.close();
    await tick();
  }
});
