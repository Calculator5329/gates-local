// The runtime switch with fake runtimes (no processes): ensure, discover,
// setMode and stopIfStartedHere run one after another.
import type { RuntimeMode, RuntimeStatus } from "@gates-local/contracts";
import { expect, it } from "vitest";
import { json, startFakeServer } from "../fit/fake-http.ts";
import { defaultSettings } from "../settings/store.ts";
import { createRuntimeHandlers } from "./handlers.ts";
import { ModelActionError, createModelLoader, type ModelLoader } from "./load.ts";
import { createModelCatalog, listLoaded } from "./models.ts";
import { createPullManager, type PullManager } from "./pull.ts";
import type { OllamaRuntime } from "./runtime.ts";
import { createRuntimeSwitch } from "./switch.ts";

type Fake = OllamaRuntime & { stops: number };

/** A runtime whose ensure "starts" an app-owned copy once `startup` resolves. */
function fakeRuntime(mode: RuntimeMode, startup: Promise<void>): Fake {
  let started = false;
  let status: RuntimeStatus = { state: "stopped", owner: "none", baseUrl: `http://${mode}.invalid` };
  const fake: Fake = {
    stops: 0,
    status: () => status,
    baseUrl: () => (status.state === "ready" ? status.baseUrl : undefined),
    discover: async () => status,
    async ensure() {
      await startup;
      started = mode === "app";
      status = { state: "ready", owner: mode === "app" ? "app" : "external", baseUrl: status.baseUrl };
      return status;
    },
    async stop() {
      fake.stops++;
      started = false;
      status = { state: "stopped", owner: "none", baseUrl: status.baseUrl };
      return { stopped: true, pid: 1 };
    },
    startedByThisProcess: () => started,
    mode,
    onChange: () => () => undefined,
    onInstallProgress: () => () => undefined,
  };
  return fake;
}

it("R-08: a switch during the app copy's startup waits for it, then stops it; nothing is orphaned", async () => {
  let release!: () => void;
  const startup = new Promise<void>((r) => (release = r));
  const made: Fake[] = [];
  const sw = createRuntimeSwitch({
    initialMode: "app",
    make: (mode) => {
      const rt = fakeRuntime(mode, mode === "app" ? startup : Promise.resolve());
      made.push(rt);
      return rt;
    },
  });
  const app = made[0]!;
  const ensuring = sw.ensure();
  const switched = sw.setMode("system");
  await new Promise((r) => setTimeout(r, 10));
  release();
  await ensuring;
  expect(await switched).toMatchObject({ state: "ready", owner: "external" });
  expect(app.stops).toBe(1);
  expect(app.startedByThisProcess()).toBe(false);
  // Shutdown: the current (system) runtime was not started here, and the old copy is gone.
  await sw.stopIfStartedHere();
  expect(made.map((m) => m.stops)).toEqual([1, 0]);
});

it("S-02: afterSwitch follows beforeSwitch once the new ensure settles, even when that ensure fails", async () => {
  const events: string[] = [];
  let fail = false;
  const sw = createRuntimeSwitch({
    initialMode: "system",
    make: (mode) => {
      const rt = fakeRuntime(mode, Promise.resolve());
      const ensure = rt.ensure.bind(rt);
      rt.ensure = async () => {
        events.push(`ensure ${mode}`);
        if (fail) throw new Error("install failed");
        return ensure();
      };
      return rt;
    },
    beforeSwitch: () => void events.push("before"),
    afterSwitch: () => events.push("after"),
  });
  await sw.setMode("app");
  expect(events).toEqual(["before", "ensure app", "after"]);
  fail = true;
  await expect(sw.setMode("system")).rejects.toThrow("install failed");
  // Without "after" here the loader would refuse every load for good.
  expect(events.slice(3)).toEqual(["before", "ensure system", "after"]);
});

it("R2-04: a pull submitted after beforeSwitch while the old runtime's stop is pending is refused; no /api/pull reaches it", async () => {
  const old = await startFakeServer({
    "POST /api/pull": (_b, res) => json(res, 200, { status: "success" }),
    "DELETE /api/delete": (_b, res) => void res.writeHead(200).end(),
    "GET /api/ps": (_b, res) => json(res, 200, { models: [] }),
    "GET /api/tags": (_b, res) => json(res, 200, { models: [] }),
  });
  let stopping!: () => void;
  const stopAsked = new Promise<void>((r) => (stopping = r));
  let finishStop!: () => void;
  const stopHeld = new Promise<void>((r) => (finishStop = r));
  const make = (mode: RuntimeMode): OllamaRuntime => {
    if (mode === "system") return fakeRuntime(mode, Promise.resolve());
    // The app's own copy, started here, at the old server; its stop hangs until released.
    const rt = fakeRuntime(mode, Promise.resolve());
    rt.status = () => ({ state: "ready", owner: "app", baseUrl: old.baseUrl });
    rt.baseUrl = () => old.baseUrl;
    rt.startedByThisProcess = () => true;
    rt.stop = async () => {
      stopping();
      await stopHeld;
      return { stopped: true, pid: 1 };
    };
    return rt;
  };
  let pulls: PullManager | undefined;
  let loader: ModelLoader | undefined;
  const sw = createRuntimeSwitch({
    initialMode: "app",
    make,
    beforeSwitch: () => {
      pulls?.stop();
      loader?.runtimeChanged();
    },
    afterSwitch: () => loader?.runtimeSettled(),
  });
  pulls = createPullManager({ baseUrl: () => sw.baseUrl(), push: () => undefined });
  loader = createModelLoader({ baseUrl: () => sw.baseUrl(), push: () => undefined, listLoaded: (u, s) => listLoaded(u, undefined, s), fit: async () => { throw new Error("no fit in this test"); } });
  const handlers = createRuntimeHandlers({ baseUrl: () => sw.baseUrl(), catalog: createModelCatalog(() => sw.baseUrl()), settings: { get: () => defaultSettings("app") }, pulls, loader });
  expect(sw.baseUrl()).toBe(old.baseUrl);
  const switched = sw.setMode("system");
  await stopAsked;
  const pull = await Promise.resolve()
    .then(() => handlers["models.pull"]({ name: "qwen3.5:9b" }))
    .catch((e: unknown) => e);
  await new Promise((r) => setTimeout(r, 50));
  expect(old.requests.filter((r) => r.path === "/api/pull")).toEqual([]);
  expect(pull).toMatchObject({ code: "runtime-not-ready" });
  const removed = await Promise.resolve()
    .then(() => handlers["models.remove"]({ name: "qwen3.5:9b" }))
    .catch((e: unknown) => e);
  expect(removed).toMatchObject({ code: "runtime-not-ready" });
  expect(await loader.load("qwen3.5:9b", 16384).catch((e: unknown) => e)).toBeInstanceOf(ModelActionError);
  expect(sw.baseUrl()).toBeUndefined();
  finishStop();
  expect(await switched).toMatchObject({ state: "ready", owner: "external" });
  expect(old.requests.map((r) => r.path)).toEqual([]);
  await old.close();
});

it("R2-03: the old runtime stops only after beforeSwitch's turns have ended", async () => {
  const made: Fake[] = [];
  let turnsEnd!: () => void;
  const turns = new Promise<void>((r) => (turnsEnd = r));
  const sw = createRuntimeSwitch({
    initialMode: "app",
    make: (mode) => {
      const rt = fakeRuntime(mode, Promise.resolve());
      made.push(rt);
      return rt;
    },
    beforeSwitch: () => turns,
  });
  await sw.ensure();
  expect(made[0]!.startedByThisProcess()).toBe(true);
  const switched = sw.setMode("system");
  await new Promise((r) => setTimeout(r, 20));
  expect(made[0]!.stops).toBe(0);
  turnsEnd();
  expect(await switched).toMatchObject({ state: "ready", owner: "external" });
  expect(made[0]!.stops).toBe(1);
});
