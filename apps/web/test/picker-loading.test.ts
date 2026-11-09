import { expect, it, vi } from "vitest";

const idle = vi.hoisted(() => ({ work: undefined as (() => void) | undefined }));
const loads = vi.hoisted(() => ({
  pickerScreen: { load: vi.fn() }, settingsScreen: { load: vi.fn() },
  firstRunScreen: { load: vi.fn() }, gpuScreen: { load: vi.fn() },
}));
vi.mock("../src/deferred.ts", () => ({ afterFirstPaint: (work: () => void) => { idle.work = work; return () => undefined; } }));
vi.mock("../src/screen-loaders.ts", () => loads);
vi.mock("../src/fit-actions.ts", () => ({ closeGpuPanel: vi.fn() }));
const { preloadScreens } = await import("../src/screens.tsx");

it("warms Settings and first run without downloading the picker at startup", () => {
  const cancel = preloadScreens();
  expect(loads.pickerScreen.load).not.toHaveBeenCalled();
  expect(idle.work).toBeDefined();
  idle.work?.();
  expect(loads.settingsScreen.load).toHaveBeenCalledTimes(1);
  expect(loads.firstRunScreen.load).toHaveBeenCalledTimes(1);
  expect(loads.pickerScreen.load).not.toHaveBeenCalled();
  cancel();
});
