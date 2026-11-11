import type { Browser } from "@playwright/test";
import { afterEach, expect, it, vi } from "vitest";

// Import the real helpers without registering or running a browser journey.
vi.mock("@playwright/test", () => ({ test: vi.fn(), expect }));
vi.mock("./probe.ts", () => ({ install: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); });

it.each([["reply", 4], ["ready", 4], ["reply", 1], ["ready", 1]] as const)("%s picker session applies throttle %s before navigation", async (kind, rate) => {
  vi.stubEnv("GL_PERF_THROTTLE", String(rate)); vi.resetModules();
  const helpers = await import("./next.spec.ts");
  const calls: unknown[][] = [];
  const reachedNavigation = new Error("stop at navigation");
  const cdp = { send: async (...args: unknown[]) => { calls.push(args); }, on: () => {} };
  const page = { goto: async () => { calls.push(["navigation"]); throw reachedNavigation; } };
  const context = { newPage: async () => page, newCDPSession: async () => cdp, close: vi.fn() };
  // Deliberately stop before navigation: only the actual helper's setup runs.
  const browser = { newContext: async () => context } as unknown as Browser;
  await expect(kind === "reply" ? helpers.pickerReplyCase(browser, "timed", "hand") : helpers.pickerReadyCase(browser, "timed", "hover")).rejects.toBe(reachedNavigation);
  if (rate > 1) {
    expect(calls).toContainEqual(["Emulation.setCPUThrottlingRate", { rate }]);
    expect(calls.findIndex(([method]) => method === "Emulation.setCPUThrottlingRate")).toBeLessThan(calls.findIndex(([method]) => method === "navigation"));
  } else expect(calls.some(([method]) => method === "Emulation.setCPUThrottlingRate")).toBe(false);
  expect(context.close).toHaveBeenCalledOnce();
});
