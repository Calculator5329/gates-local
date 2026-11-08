// The runtime switch with fake runtimes (no processes): ensure, discover,
// setMode and stopIfStartedHere run one after another.
import type { RuntimeMode, RuntimeStatus } from "@gates-local/contracts";
import { expect, it } from "vitest";
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
    beforeSwitch: () => events.push("before"),
    afterSwitch: () => events.push("after"),
  });
  await sw.setMode("app");
  expect(events).toEqual(["before", "ensure app", "after"]);
  fail = true;
  await expect(sw.setMode("system")).rejects.toThrow("install failed");
  // Without "after" here the loader would refuse every load for good.
  expect(events.slice(3)).toEqual(["before", "ensure system", "after"]);
});
