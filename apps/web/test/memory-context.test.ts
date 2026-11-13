import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { FitRow, FitTable } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import type { State } from "../src/store.ts";
import { installBrowser, tick, until } from "./harness.ts";

vi.mock("../src/store.ts", async (original) => {
  const actual = await original<typeof import("../src/store.ts")>();
  return { ...actual, useStore: <T>(selector: (s: State) => T) => selector(actual.getState()) };
});
import { getState, setState } from "../src/store.ts";

const sample = methodSamples["fit.table"].result;
const row = sample.rows[0]!;
const MODEL = row.model;
const at = (numCtx: number, over: Partial<FitRow> = {}): FitRow => ({ ...row, numCtx, verdict: "fits", ...over });
const tableOf = (rows: FitRow[], seq = 1): FitTable => ({ ...sample, reading: { ...sample.reading, seq }, rows });
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
    model: MODEL, numCtx: 65536, models: [{ ...methodSamples["models.list"].result[0]!, name: MODEL }],
    settings: { ...methodSamples["settings.get"].result, defaultNumCtx: 16384 },
    fitPanel: { model: null }, gpu: methodSamples["gpu.status"].result,
    fitTable: tableOf([at(16384)]),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("describes the selected chat's 64k breakdown while the saved default stays 16k", () => {
  setState({ fitTable: tableOf([at(16384), at(65536, { verdict: "refuse", needVramBytes: row.freeVramBytes + 1024 ** 3 })]) });
  expect(text()).toContain("Needs");
  expect(text()).toContain("more at 64k");
  expect(text()).toContain("needs an estimated");
  expect(html()).toMatch(/data-ctx="16384"[^>]*aria-pressed="true"/);
  expect(getState().settings).toMatchObject({ defaultNumCtx: 16384 });
});

it("does not borrow the saved default's fits verdict when the table has no row for the selected size", () => {
  expect(text()).toContain("No GPU memory reading");
  expect(text()).not.toMatch(/run(s)? well/i);
});

it("shows a skeleton, not words, before the first table", () => {
  setState({ fitTable: undefined });
  expect(html()).toContain("fit-skel");
  expect(text()).not.toContain("Checking");
});

it("labels the clamped size that will actually be sent", () => {
  setState(s => ({ models: s.models?.map(m => ({ ...m, maxContext: 32768 })), fitTable: tableOf([at(32768)]) }));
  expect(text()).toContain("at 32k");
  expect(text()).not.toContain("at 64k");
});

it("a pushed table changes the verdict in place, with no checking state between", async () => {
  const b = installBrowser();
  b.server.answer("fit.table", () => tableOf([at(65536)], 1));
  const session = await import("../src/session.ts");
  const disconnect = session.connect();
  try {
    setState({ fitTable: undefined });
    await until(() => getState().fitTable !== undefined);
    setState({ model: MODEL, numCtx: 65536, settings: { ...methodSamples["settings.get"].result, defaultNumCtx: 65536 } });
    expect(text()).toContain("Should run well");
    b.server.push("fit.changed", tableOf([at(65536, { verdict: "refuse", needVramBytes: row.freeVramBytes + 1024 ** 3 })], 2));
    await until(() => getState().fitTable?.reading.seq === 2);
    // the default is 64k too, so the control above already names the size
    expect(text()).toMatch(/Needs [\d.]+\sGB more(?! at)/);
    expect(text()).not.toContain("run well");
  } finally {
    disconnect();
    b.server.accepting = false;
    for (const socket of b.server.sockets) socket.close();
    await tick();
  }
});
