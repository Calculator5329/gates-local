// Displayed reports survive refreshes; refreshes still replace them, and an
// answer measured before a newer invalidation must never become current.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import { type Browser, installBrowser, tick, until } from "./harness.ts";

let b: Browser;
let session: typeof import("../src/session.ts");
let store: typeof import("../src/store.ts");
let disconnect: (() => void) | undefined;
const report = methodSamples["fit.check"].result;
const model = report.model;
const ctx = report.numCtx;

beforeEach(async () => {
  b = installBrowser();
  vi.resetModules();
  session = await import("../src/session.ts");
  store = await import("../src/store.ts");
  disconnect = session.connect();
  await until(() => store.getState().imageStatus !== undefined, 2000, "hydration");
  await tick();
  store.setState({ model, numCtx: 32768 });
});

afterEach(async () => {
  disconnect?.();
  b.server.accepting = false;
  for (const s of b.server.sockets) s.close();
  await tick(10);
  vi.unstubAllGlobals();
});

it("keeps the last report through a GPU push, then shows the refreshed refusal", async () => {
  session.ensureFit(model, ctx);
  const key = store.fitKey(model, ctx);
  await until(() => store.getState().fits[key] !== undefined);
  const next = b.server.hold("fit.check");
  b.server.push("gpu.changed", methodSamples["gpu.status"].result);
  session.ensureFit(model, ctx);
  const held = await next;
  expect(store.getState().fits[key]).toEqual(report);
  held.respond({ ...report, verdict: "refuse", needVramBytes: report.freeVramBytes + 1024 ** 3 });
  await until(() => {
    const fit = store.getState().fits[key];
    return fit !== undefined && fit !== "error" && fit.verdict === "refuse";
  });
  expect(store.getState().fits[key]).toMatchObject({ verdict: "refuse" });
});

it("a refresh failure replaces the held report with the error", async () => {
  session.ensureFit(model, ctx);
  const key = store.fitKey(model, ctx);
  await until(() => store.getState().fits[key] !== undefined);
  const next = b.server.hold("fit.check");
  b.server.push("gpu.changed", methodSamples["gpu.status"].result);
  session.ensureFit(model, ctx);
  const held = await next;
  expect(store.getState().fits[key]).toEqual(report);
  held.fail("internal", "test GPU unavailable");
  await until(() => store.getState().fits[key] === "error");
});

it("a late answer from before a GPU change is discarded and checked again", async () => {
  const old = b.server.hold("fit.check");
  session.ensureFit(model, ctx);
  const heldOld = await old;
  const next = b.server.hold("fit.check");
  b.server.push("gpu.changed", methodSamples["gpu.status"].result);
  heldOld.respond(report);
  await tick();
  const key = store.fitKey(model, ctx);
  expect(store.getState().fits[key]).toBeUndefined();
  const heldNext = await next;
  heldNext.respond({ ...report, verdict: "refuse" });
  await until(() => store.getState().fits[key] !== undefined);
  expect(store.getState().fits[key]).toMatchObject({ verdict: "refuse" });
});
