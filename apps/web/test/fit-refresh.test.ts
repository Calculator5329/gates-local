// Displayed reports survive refreshes; refreshes still replace them, and an
// answer measured before a newer invalidation must never become current.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import type { FitReport } from "@gates-local/contracts";
import { type Browser, installBrowser, tick, until } from "./harness.ts";

let b: Browser;
let session: typeof import("../src/session.ts");
let store: typeof import("../src/store.ts");
let disconnect: (() => void) | undefined;
const report = methodSamples["fit.check"].result;
const model = report.model;
const ctx = 32768;

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

const authorizes = (r: FitReport | "error" | undefined) => session.fitIsCurrent(r);

it("a load retains displayed advice but only a fresh fit.check answer authorizes a pick", async () => {
  store.setState({ numCtx: ctx });
  session.ensureFit(model, ctx);
  const key = store.fitKey(model, ctx);
  await until(() => store.getState().fits[key] !== undefined);
  const cached = store.getState().fits[key];
  expect(authorizes(cached)).toBe(true);
  const next = b.server.hold("fit.check");
  b.server.push("models.load", { model, numCtx: ctx, state: "ready" });
  const held = await next;
  expect(session.currentFit(cached)).toBe(cached);
  expect.soft(authorizes(cached)).toBe(false);
  held.respond({ ...report, measuredAt: report.measuredAt + 1 });
  await until(() => store.getState().fits[key] !== cached);
  expect(authorizes(store.getState().fits[key])).toBe(true);
  expect(authorizes({ ...report })).toBe(false);
});

it("PK-01 replay: a catalog survey arriving after invalidation never authorizes a pick", async () => {
  const next = b.server.hold("models.catalog");
  b.server.push("models.changed", store.getState().models ?? []);
  const held = await next;
  b.server.push("gpu.changed", methodSamples["gpu.status"].result);
  const entry = methodSamples["models.catalog"].result[0];
  if (!entry) throw new Error("missing catalog fixture");
  held.respond([{ ...entry, name: model, fit: { ...report, verdict: "fits" } }]);
  await tick();
  const catalog = store.getState().catalog;
  if (!catalog || catalog === "na") throw new Error("catalog did not arrive");
  const arrived = catalog[0]?.fit;
  expect(arrived).toBeDefined();
  expect(session.currentFit(arrived)).toBe(arrived);
  expect(authorizes(arrived)).toBe(false);
});

it.each(["allocation", "RAM"])("PK-03/04 replay: retained words cannot authorize after %s changes the server verdict", async change => {
  const mib = 1024 ** 2, gib = 1024 ** 3;
  store.setState({ numCtx: ctx });
  b.server.answer("fit.check", () => ({ ...report, verdict: change === "RAM" ? "spills" : "fits" }));
  b.server.answer("turns.blocking", () => []);
  session.ensureFit(model, ctx);
  const key = store.fitKey(model, ctx);
  await until(() => store.getState().fits[key] !== undefined);
  const cached = store.getState().fits[key];
  const before = { ...methodSamples["gpu.status"].result, freeBytes: 8 * gib, occupants: [], systemMemoryAvailableBytes: 10 * gib };
  store.setState({ gpu: before });
  const next = b.server.hold("fit.check");
  b.server.push("gpu.changed", { ...before, freeBytes: before.freeBytes - 6926 * mib,
    occupants: [{ kind: "chat-model", label: model, bytes: 6926 * mib, protected: false }],
    systemMemoryAvailableBytes: (change === "RAM" ? 1 : 10) * gib });
  const held = await next;
  expect(session.currentFit(cached)).toBe(cached);
  expect.soft(authorizes(cached)).toBe(false);
  // planLoad can reclaim only 6,062 MiB of the 6,926 MiB allocation, or the spill no longer fits RAM.
  held.respond({ ...report, verdict: "refuse", freeVramBytes: before.freeBytes - (6926 - 6062) * mib });
  await until(() => store.getState().fits[key] !== cached);
  expect(store.getState().fits[key]).toMatchObject({ verdict: "refuse" });
  expect(authorizes(store.getState().fits[key])).toBe(true);
});

it("PK-01: a GPU invalidation withdraws a catalog-only report too", () => {
  const entry = methodSamples["models.catalog"].result[0];
  if (!entry) throw new Error("missing catalog fixture");
  store.setState({ fits: {}, catalog: [{ ...entry, name: model, fit: report }] });
  b.server.push("gpu.changed", methodSamples["gpu.status"].result);
  expect.soft(session.currentFit(report)).toBeUndefined();
  expect(store.getState().staleFits[store.fitKey(model, ctx)]).toBe(true);
});

it.each(["own", "rounding", "external", "occupant", "unowned", "busy", "preload"])("only an idle app-owned allocation change retains advice (%s)", async change => {
  session.ensureFit(model, ctx);
  const key = store.fitKey(model, ctx);
  await until(() => store.getState().fits[key] !== undefined);
  const cached = store.getState().fits[key];
  const fixture = methodSamples["gpu.status"].result;
  const base: typeof fixture = change === "rounding" ? { ...fixture, occupants: [...fixture.occupants, { kind: "unknown", label: "Other", bytes: 210 * 1024 ** 2, protected: true }] } : fixture;
  store.setState({ gpu: base });
  const bytes = 4 * 1024 ** 3;
  const next = b.server.hold("fit.check");
  b.server.push("models.load", { model, numCtx: ctx, state: "ready" });
  const held = await next;
  if (change === "busy") store.setState({ runningTurns: { active: "turn" } });
  if (change === "preload") store.setState({ loads: { other: { model: "other", state: "loading", numCtx: ctx } } });
  b.server.push("gpu.changed", {
    ...base,
    freeBytes: (base.freeBytes ?? 0) - bytes - (change === "external" ? 128 * 1024 ** 2 : 0),
    occupants: [...base.occupants.map(o => change === "occupant" ? { ...o, label: o.label + " changed" } : change === "rounding" && o.kind === "unknown" ? { ...o, bytes: o.bytes - 1234 } : o), { label: model, kind: "chat-model", protected: change === "unowned", bytes: bytes + (change === "rounding" ? 1234 : 0) }],
  });
  if (change === "own" || change === "rounding") expect(session.currentFit(cached)).toBe(cached);
  else expect(session.currentFit(cached)).toBeUndefined();
  held.respond(report);
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

it("a refresh failure marks the held report stale with a visible error", async () => {
  session.ensureFit(model, ctx);
  const key = store.fitKey(model, ctx);
  await until(() => store.getState().fits[key] !== undefined);
  const next = b.server.hold("fit.check");
  b.server.push("gpu.changed", methodSamples["gpu.status"].result);
  session.ensureFit(model, ctx);
  const held = await next;
  expect(store.getState().fits[key]).toEqual(report);
  held.fail("internal", "test GPU unavailable");
  await until(() => store.getState().fitStatus[key] === "error");
  expect(store.getState().fitHistory[key]).toEqual(report);
  expect(session.fitIsCurrent(store.getState().fits[key])).toBe(false);
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
