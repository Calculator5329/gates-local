import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";

const keys = vi.hoisted(() => [] as { tip: string; key: unknown }[]);
const bars = vi.hoisted(() => [] as unknown[]);
vi.mock("react/jsx-runtime", async original => {
  const actual = await original<typeof import("react/jsx-runtime")>();
  const wrap = (method: "jsx" | "jsxs") => (...args: Parameters<typeof actual.jsx>) => {
    const [, props, key] = args;
    if (typeof props === "object" && props !== null && "className" in props && ["sw-occ", "sw-other", "sw-whisper"].includes(String(props.className))) bars.push(key);
    if (typeof props === "object" && props !== null && "className" in props && props.className === "lg-r" && "data-tip" in props && typeof props["data-tip"] === "string") keys.push({ tip: props["data-tip"], key });
    return actual[method](...args);
  };
  return { ...actual, jsx: wrap("jsx"), jsxs: wrap("jsxs") };
});
vi.mock("react/jsx-dev-runtime", async original => {
  const actual = await original<typeof import("react/jsx-dev-runtime")>();
  return { ...actual, jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => {
    const [, props, key] = args;
    if (typeof props === "object" && props !== null && "className" in props && ["sw-occ", "sw-other", "sw-whisper"].includes(String(props.className))) bars.push(key);
    if (typeof props === "object" && props !== null && "className" in props && props.className === "lg-r" && "data-tip" in props && typeof props["data-tip"] === "string") keys.push({ tip: props["data-tip"], key });
    return actual.jsxDEV(...args);
  } };
});
vi.mock("../src/store.ts", async original => {
  const actual = await original<typeof import("../src/store.ts")>();
  return { ...actual, useStore: <T>(select: (s: ReturnType<typeof actual.getState>) => T) => select(actual.getState()) };
});
import { fitKey, setState } from "../src/store.ts";
let GpuMemory: typeof import("../src/FitPanel.tsx")["GpuMemory"];
beforeAll(async () => { vi.stubGlobal("window", {}); GpuMemory = (await import("../src/FitPanel.tsx")).GpuMemory; });
afterAll(() => vi.unstubAllGlobals());
it("keys legend rows by occupant identity across memory-order changes", () => {
  const fit = { ...methodSamples["fit.check"].result, numCtx: 16384 };
  const whisper = { kind: "whisper" as const, label: "Whisper", bytes: 2 * 1024 ** 3, protected: true };
  const other = { kind: "unknown" as const, label: "Other", bytes: 1024 ** 3, protected: true };
  const gpu = { ...methodSamples["gpu.status"].result, vendor: "nvidia" as const, totalBytes: 16 * 1024 ** 3, occupants: [whisper, other] };
  setState({ conn: { kind: "open" }, runtime: methodSamples["runtime.status"].result, model: fit.model, numCtx: 16384, fits: { [fitKey(fit.model, 16384)]: fit }, gpu, fitPanel: { model: null } });
  keys.length = 0; renderToStaticMarkup(createElement(GpuMemory));
  const before = keys.find(row => row.tip.includes("Whisper"))?.key;
  expect(before).toBeDefined();
  setState({ gpu: { ...gpu, occupants: [{ ...other, bytes: 3 * 1024 ** 3 }, whisper] } });
  keys.length = 0; renderToStaticMarkup(createElement(GpuMemory));
  expect(keys.find(row => row.tip.includes("Whisper"))?.key).toBe(before);
});

it("FR-06 keeps duplicate occupants distinct and stable across other occupants and byte changes", () => {
  const fit = { ...methodSamples["fit.check"].result, numCtx: 16384 };
  const python = { kind: "other-app" as const, label: "Python", bytes: 2 * 1024 ** 3, protected: true };
  const whisper = { kind: "whisper" as const, label: "Whisper", bytes: 1024 ** 3, protected: true };
  const gpu = { ...methodSamples["gpu.status"].result, vendor: "nvidia" as const, totalBytes: 16 * 1024 ** 3, occupants: [python, { ...python, bytes: 1024 ** 3 }, whisper] };
  setState({ conn: { kind: "open" }, runtime: methodSamples["runtime.status"].result, model: fit.model, numCtx: 16384, fits: { [fitKey(fit.model, 16384)]: fit }, gpu, fitPanel: { model: null } });
  keys.length = 0; bars.length = 0; renderToStaticMarkup(createElement(GpuMemory));
  const before = keys.filter(row => !row.tip.includes("Whisper")).map(row => row.key);
  expect(before).toHaveLength(2);
  expect(new Set(before).size).toBe(2);
  expect(bars).toEqual(keys.map(row => row.key));
  setState({ gpu: { ...gpu, occupants: [{ ...whisper, bytes: 4 * 1024 ** 3 }, { ...python, bytes: 3 * 1024 ** 3 }, python] } });
  keys.length = 0; bars.length = 0; renderToStaticMarkup(createElement(GpuMemory));
  expect(keys.filter(row => !row.tip.includes("Whisper")).map(row => row.key)).toEqual(before);
  expect(bars).toEqual(keys.map(row => row.key));
});
