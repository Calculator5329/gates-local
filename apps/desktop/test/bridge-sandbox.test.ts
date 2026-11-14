// Main tells the client when Chromium's sandbox is off (an AppImage launcher's --no-sandbox), so
// pages wait for a click there; only a ready state carries it, and only when it is true.
import { describe, expect, it } from "vitest";
import { toBridgeState } from "../src/bridge.ts";

const READY = { status: "ready", launch: 1, pid: 42, port: 5186, url: "ws://127.0.0.1:5186/?token=t" } as const;

describe("the sandbox switch in the bridge state", () => {
  it("rides on the ready state only when the switch is set", () => {
    expect(toBridgeState(READY, true)).toEqual({ status: "ready", launch: 1, port: 5186, serverUrl: READY.url, sandboxOff: true });
    expect(toBridgeState(READY, false)).not.toHaveProperty("sandboxOff");
    expect(toBridgeState(READY)).not.toHaveProperty("sandboxOff");
    expect(toBridgeState({ status: "starting", launch: 1 }, true)).toEqual({ status: "starting", launch: 1 });
  });
});
