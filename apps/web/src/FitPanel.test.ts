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
  fitKey: (model: string, ctx: number) => `${model}@${ctx}`, setState: () => undefined,
}));
vi.mock("./session.ts", () => ({ ensureFit: () => undefined, setContext: () => undefined, updateSettings: () => undefined }));
const { GpuMemory } = await import("./FitPanel.tsx");

const detail = "Gates Local could not read GPU memory (nvidia-smi timed out), so it cannot check whether a model fits. Try again. If this keeps happening, run nvidia-smi in a terminal to check the NVIDIA driver.";

function panel(gpu: GpuStatus, history: boolean, pending = false): string {
  const previous = { model: "chat", numCtx: 16384, verdict: "fits", needVramBytes: 5e9, freeVramBytes: 8e9, spillRamBytes: 0, source: "estimate", measuredAt: 0 };
  store.state = {
    model: "chat", numCtx: 16384, fitPanel: { model: null }, settings: { defaultNumCtx: 16384 },
    gpu, models: [], catalog: [], loads: { chat: { state: "ready", numCtx: 16384 } }, messages: {}, firstToken: {},
    fits: pending ? {} : { "chat@16384": "error" }, fitStatus: { "chat@16384": pending ? "checking" : "error" }, fitHistory: history ? { "chat@16384": previous } : {}, staleFits: {},
  };
  return renderToStaticMarkup(createElement(GpuMemory));
}

it.each([false, true])("shows the GPU refusal outside collapsed details, earlier check: %s", (history) => {
  const html = panel({ vendor: "unreadable", detail, occupants: [], systemMemoryAvailableBytes: 16e9, measuredAt: 1 }, history);
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

it.each([false, true])("a no-GPU notice keeps the memory check line, pending: %s", (pending) => {
  const html = panel({ vendor: "none", occupants: [], systemMemoryAvailableBytes: 16e9, measuredAt: 1 }, false, pending);
  expect(html).toContain(pending ? "Checking memory…" : "Gates Local couldn&#x27;t check memory for chat right now.");
});

it("keeps the existing no-GPU wording when nvidia-smi is absent", async () => {
  const gpu = await readGpuStatus({ platform: "win32", freemem: () => 16e9, runNvidiaSmi: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } });
  expect(panel(gpu, true).split("<details")[0]).toContain(NO_GPU_TEXT);
});
