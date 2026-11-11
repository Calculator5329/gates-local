import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { readGpuStatus } from "../../server/src/fit/gpu-status.ts";
import type { GpuStatus } from "@gates-local/contracts";
import { NO_GPU_TEXT } from "./format.ts";

const store = vi.hoisted(() => ({ state: undefined as unknown }));
vi.mock("./store.ts", () => ({
  NA: "na", chatReady: () => true,
  useStore: (select: (s: unknown) => unknown) => select(store.state),
  setState: () => undefined,
}));
vi.mock("./session.ts", () => ({ setContext: () => undefined, updateSettings: () => undefined }));
const { GpuMemory } = await import("./FitPanel.tsx");

const detail = "Gates Local could not read GPU memory (nvidia-smi timed out), so it cannot check whether a model fits. Try again. If this keeps happening, run nvidia-smi in a terminal to check the NVIDIA driver.";

/** The panel for model "chat"; `tabled`: a fit table has arrived (with no row for "chat"). */
function panel(gpu: GpuStatus, tabled: boolean): string {
  store.state = {
    model: "chat", numCtx: 16384, fitPanel: { model: null }, settings: { defaultNumCtx: 16384 },
    gpu, models: [], catalog: [], loads: { chat: { state: "ready", numCtx: 16384 } }, messages: {}, firstToken: {},
    fitTable: tabled ? { reading: { boot: "b", seq: 1, measuredAt: 1 }, memory: { kind: "cpu" }, rows: [] } : undefined, unavailable: {},
  };
  return renderToStaticMarkup(createElement(GpuMemory));
}

it.each([false, true])("shows the GPU refusal outside collapsed details, table arrived: %s", (tabled) => {
  const html = panel({ vendor: "unreadable", detail, occupants: [], systemMemoryAvailableBytes: 16e9, measuredAt: 1 }, tabled);
  expect(html.split("<details")[0]).toContain(detail);
  expect(html.split(detail)).toHaveLength(2);
});

it.each(["No devices were found", "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver. Make sure that the latest NVIDIA driver is installed and running. This can also be happening if non-NVIDIA GPU is running as primary display, and NVIDIA GPU is in WDDM mode."])("shows conditional driver repair advice before details: %s", async (message) => {
  const gpu = await readGpuStatus({ platform: "win32", freemem: () => 16e9, runNvidiaSmi: async () => { throw new Error(message); } });
  const html = panel(gpu, true);
  const visible = html.split("<details")[0];
  expect.soft(gpu.vendor).toBe("none");
  expect.soft(visible).toContain("If this computer has an NVIDIA card, its driver is not answering: fix or reinstall the NVIDIA driver.");
  expect.soft(visible).toContain("Until then models run in system memory.");
  expect(visible).not.toContain("No supported GPU");
  expect.soft(html).toContain("NVIDIA GPU unavailable");
  expect.soft(html).not.toContain("no supported GPU");
});

it.each([false, true])("a no-GPU notice keeps the memory line, table arrived: %s", (tabled) => {
  const html = panel({ vendor: "none", occupants: [], systemMemoryAvailableBytes: 16e9, measuredAt: 1 }, tabled);
  expect(html).toContain(tabled ? "No memory reading for chat." : "fit-skel");
  expect(html).not.toContain("Checking");
});

it("waits for the GPU reading before showing a row, so Details never grows when it lands", () => {
  store.state = {
    model: "chat", numCtx: 16384, fitPanel: { model: null }, settings: { defaultNumCtx: 16384 },
    gpu: undefined, models: [], catalog: [], loads: {}, messages: {}, firstToken: {}, unavailable: {},
    fitTable: { reading: { boot: "b", seq: 1, measuredAt: 1 }, memory: { kind: "gpu", freeBytes: 12e9, usableBytes: 11e9 }, rows: [{ model: "chat", numCtx: 16384, freeVramBytes: 12e9, needVramBytes: 9e9, spillRamBytes: 0, verdict: "gpu", source: "estimate", stops: [] }] },
  };
  const html = renderToStaticMarkup(createElement(GpuMemory));
  expect(html).toContain("fit-skel");
  expect(html).not.toContain("<details");
  expect(html).not.toContain("couldn't read the GPU");
});

it("keeps the existing no-GPU wording when nvidia-smi is absent", async () => {
  const gpu = await readGpuStatus({ platform: "win32", freemem: () => 16e9, runNvidiaSmi: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } });
  expect(panel(gpu, true).split("<details")[0]).toContain(NO_GPU_TEXT);
});
