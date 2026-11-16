// The models kind at the client boundary: a read that lands after a newer value of its thing (a
// push, or a later read) must not undo it. The window keeps no ticket, table counter or held batch
// of its own for these; the numbers the socket server gives each frame decide.
import { afterEach, expect, it, vi } from "vitest";
import type { CatalogEntry, FitTable, GpuStatus, MeasureRun, ModelInfo, RuntimeStatus } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { installBrowser } from "../../../test/harness.ts";
import { numberServer } from "../../../test/numbered-server.ts";
import { drain } from "../../../test/ordering-world.ts";

const listed = methodSamples["models.list"].result;
const ready: RuntimeStatus = methodSamples["runtime.status"].result;
const first = listed.models[0];
if (first === undefined) throw new Error("Missing model fixture");
const older: readonly ModelInfo[] = listed.models;
const newer: readonly ModelInfo[] = [...listed.models, { ...first, name: "added:7b" }];

async function boot() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const browser = installBrowser();
  const server = numberServer(browser.server, { serves: ["settings", "sources", "updates", "models"] });
  vi.resetModules();
  const session = await import("./index.ts");
  const store = await import("../store/store.ts");
  return { browser, server, session, store };
}

/** Connect and let the hydrate finish. */
async function hydrated() {
  const world = await boot();
  const close = world.session.connect();
  for (let turn = 0; turn < 30 && world.store.getState().measures === undefined; turn++) await drain();
  return { ...world, close };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("the window orders the models kind", async () => {
  const { server, close } = await hydrated();
  expect(server.ordered()).toContain("models");
  close();
});

it("a slow list refresh never undoes a models.changed that overtook it", async () => {
  const { browser, server, session, store, close } = await hydrated();
  const reading = browser.server.hold("models.refresh");
  const asked = session.refreshModels();
  const slow = await reading;
  server.push("models.changed", newer);
  await drain();
  slow.respond({ runtime: ready, models: older });
  await asked;
  await drain();
  expect(store.getState().models?.map((m) => m.name), "the pushed list stays").toEqual(newer.map((m) => m.name));
  close();
});

it("MP2-02: of two list refreshes, the one asked first and answered last never undoes the newer", async () => {
  const { browser, session, store, close } = await hydrated();
  const reading = browser.server.hold("models.refresh");
  const askedFirst = session.refreshModels();
  const slow = await reading;
  const rereading = browser.server.hold("models.refresh");
  const askedSecond = session.refreshModels();
  (await rereading).respond({ runtime: ready, models: newer });
  await askedSecond;
  slow.respond({ runtime: ready, models: older });
  await askedFirst;
  await drain();
  expect(store.getState().models?.map((m) => m.name), "the newer read stays").toEqual(newer.map((m) => m.name));
  close();
});

it("a slow Retry answer never undoes a runtime.changed that overtook it", async () => {
  const { browser, server, session, store, close } = await hydrated();
  const reading = browser.server.hold("runtime.retry");
  const refreshing = browser.server.hold("models.refresh");
  const asked = session.recheckRuntime();
  const slow = await reading;
  const down: RuntimeStatus = { ...ready, state: "stopped" };
  server.push("runtime.changed", down);
  await drain();
  slow.respond(ready);
  // the list the Retry reads next is still out: only the Retry's own answer has landed
  const refresh = await refreshing;
  await drain();
  expect(store.getState().runtime?.state, "the pushed status stays").toBe("stopped");
  refresh.respond({ runtime: down, models: older });
  await asked;
  close();
});

it("a catalog read asked first and answered last never undoes the newer one", async () => {
  const { browser, server, store, close } = await hydrated();
  const entry = methodSamples["models.catalog"].result[0];
  if (entry === undefined) throw new Error("Missing catalog fixture");
  const before: readonly CatalogEntry[] = [entry];
  const after: readonly CatalogEntry[] = [entry, { ...entry, name: "added:7b" }];
  const firstRead = browser.server.hold("models.catalog");
  server.push("models.suggested", methodSamples["models.suggested"].result);
  const early = await firstRead;
  const secondRead = browser.server.hold("models.catalog");
  server.push("models.suggested", methodSamples["models.suggested"].result);
  const late = await secondRead;
  late.respond(after);
  await drain();
  early.respond(before);
  await drain();
  expect((store.getState().catalog as readonly CatalogEntry[]).map((c) => c.name), "the read asked last stays").toEqual(after.map((c) => c.name));
  close();
});

it("a slow fit table read never undoes a newer fit.changed", async () => {
  const { browser, server, session, store } = await boot();
  const reading = browser.server.hold("fit.table");
  const close = session.connect();
  const slow = await reading;
  const table: FitTable = methodSamples["fit.table"].result;
  const pushed: FitTable = { ...table, rows: [] };
  server.push("fit.changed", pushed);
  await drain();
  slow.respond(table);
  await drain();
  expect(store.getState().fitTable?.rows, "the pushed table stays").toEqual([]);
  close();
});

it("a slow GPU read never undoes a newer gpu.changed", async () => {
  const { browser, server, session, store } = await boot();
  const reading = browser.server.hold("gpu.status");
  const close = session.connect();
  const slow = await reading;
  const gpu: GpuStatus = methodSamples["gpu.status"].result;
  server.push("gpu.changed", { ...gpu, vendor: "unreadable" });
  await drain();
  slow.respond(gpu);
  await drain();
  expect((store.getState().gpu as GpuStatus | undefined)?.vendor, "the pushed reading stays").toBe("unreadable");
  close();
});

it("a slow speeds read never undoes a newer models.speed", async () => {
  const { browser, server, session, store } = await boot();
  const reading = browser.server.hold("models.speed");
  const close = session.connect();
  const slow = await reading;
  server.push("models.speed", [{ model: first.name, tokensPerSecond: 50, replies: 3 }]);
  await drain();
  slow.respond([{ model: first.name, tokensPerSecond: 10, replies: 1 }]);
  await drain();
  const speeds = store.getState().speeds;
  expect(speeds === "na" ? undefined : speeds?.[first.name]?.tokensPerSecond, "the pushed speed stays").toBe(50);
  close();
});

it("a slow measures read never undoes a newer step of the run", async () => {
  const { browser, server, session, store } = await boot();
  const reading = browser.server.hold("models.measures");
  const close = session.connect();
  const slow = await reading;
  const step1: MeasureRun = { model: first.name, state: "running", done: 1, total: 4 };
  server.push("models.measuring", { ...step1, done: 3 });
  await drain();
  slow.respond({ measures: [], run: step1 });
  await drain();
  expect(store.getState().measuring[first.name]?.done, "the pushed step stays").toBe(3);
  close();
});

it("a reload during a download never steps its bar back: an older pulls read under a newer push", async () => {
  const { browser, server, session, store } = await boot();
  const reading = browser.server.hold("models.pulls");
  const close = session.connect();
  const slow = await reading;
  server.push("models.pull", { name: "fresh:7b", state: "downloading", completedBytes: 55, totalBytes: 100 });
  await drain();
  slow.respond([{ name: "fresh:7b", state: "downloading", completedBytes: 20, totalBytes: 100 }]);
  for (let turn = 0; turn < 30 && store.getState().measures === undefined; turn++) await drain();
  expect(store.getState().pulls["fresh:7b"]?.completedBytes, "the pushed progress stays").toBe(55);
  close();
});
