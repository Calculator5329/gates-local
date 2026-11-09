// Pull completion and the installed-list update are separate messages.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PullProgress } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { type Browser, installBrowser, tick, until } from "./harness.ts";

let b: Browser;
let store: typeof import("../src/store.ts");
let disconnect: (() => void) | undefined;
const model = methodSamples["models.list"].result[0]!;
const done: PullProgress = { name: model.name, state: "done", completedBytes: model.sizeBytes, totalBytes: model.sizeBytes };

beforeEach(async () => {
  b = installBrowser();
  vi.resetModules();
  const session = await import("../src/session.ts");
  store = await import("../src/store.ts");
  disconnect = session.connect();
  await until(() => store.getState().imageStatus !== undefined, 2000, "hydration");
  await tick();
});
afterEach(async () => {
  disconnect?.();
  b.server.accepting = false;
  for (const s of b.server.sockets) s.close();
  await tick(10);
  vi.unstubAllGlobals();
});

it("holds completion until the installed list arrives, then removal cannot revive it", async () => {
  store.setState({ models: [], pulls: {} });
  const refresh = b.server.hold("models.refresh");
  b.server.push("models.pull", done);
  const held = await refresh;
  expect(store.getState().pulls[model.name]).toEqual(done);
  b.server.push("models.changed", [model]);
  await tick();
  expect(store.getState().pulls[model.name]).toBeUndefined();
  b.server.push("models.changed", []);
  held.respond([]);
  await tick();
  expect(store.getState().pulls[model.name]).toBeUndefined();
});

it("a completion arriving after its installed list does not create a pending row", async () => {
  store.setState({ models: [model], pulls: {} });
  b.server.push("models.pull", done);
  await tick();
  expect(store.getState().pulls[model.name]).toBeUndefined();
});

it("a refreshed list settles completion without needing a list push", async () => {
  store.setState({ models: [], pulls: {} });
  const refresh = b.server.hold("models.refresh");
  b.server.push("models.pull", done);
  const held = await refresh;
  held.respond([model]);
  await until(() => store.getState().models?.some((m) => m.name === model.name) === true);
  expect(store.getState().pulls[model.name]).toBeUndefined();
});

it("a list update preserves active progress and an actual download failure", async () => {
  const active: PullProgress = { ...done, state: "downloading", completedBytes: 1 };
  store.setState({ models: [], pulls: { [model.name]: active } });
  b.server.push("models.changed", [model]);
  await tick();
  expect(store.getState().pulls[model.name]).toEqual(active);
  const failed: PullProgress = { ...active, state: "error", message: "Fixture download failed." };
  store.setState({ pulls: { [model.name]: failed } });
  b.server.push("models.changed", [model]);
  await tick();
  expect(store.getState().pulls[model.name]).toEqual(failed);
});
