// Every method the preload exposes reaches main over its own IPC channel.
import { expect, it, vi } from "vitest";
import { BRIDGE_KEY, IPC, type GatesLocalBridge } from "../src/bridge.ts";

const fake = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: vi.fn(async (_channel: string, ..._args: unknown[]): Promise<unknown> => ({ status: "starting" })),
  on: vi.fn(), removeListener: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => fake.exposed.set(key, api) },
  ipcRenderer: { invoke: fake.invoke, on: fake.on, removeListener: fake.removeListener },
}));
await import("../src/preload.ts");
const bridge = fake.exposed.get(BRIDGE_KEY) as GatesLocalBridge;

const request = { version: "1.2.3" } as unknown as Parameters<GatesLocalBridge["updateAndRestart"]>[0];
const colors = { color: "#000", symbolColor: "#fff" };
// One row per bridge method: how to call it, the channel and arguments main must receive.
const rows: Record<Exclude<keyof GatesLocalBridge, "updateApprovalVersion" | "onState">, readonly [(b: GatesLocalBridge) => Promise<unknown>, string, readonly unknown[]]> = {
  syncTitleBar: [b => b.syncTitleBar(colors), IPC.titleBar, [colors]],
  getState: [b => b.getState(), IPC.getState, []],
  getServerUrl: [b => b.getServerUrl(), IPC.getState, []],
  restart: [b => b.restart(), IPC.restart, []],
  reloadClient: [b => b.reloadClient(), IPC.reloadClient, []],
  updateAndRestart: [b => b.updateAndRestart(request), IPC.updateAndRestart, [request]],
  dataFolder: [b => b.dataFolder(), IPC.dataFolder, []],
  openDataFolder: [b => b.openDataFolder(), IPC.openDataFolder, []],
  modelsFolder: [b => b.modelsFolder(), IPC.modelsFolder, []],
  openModelsFolder: [b => b.openModelsFolder(), IPC.openModelsFolder, []],
  pickFolder: [b => b.pickFolder("F:\\models"), IPC.pickFolder, ["F:\\models"]],
};

it("covers every method the bridge exposes", () => {
  expect(Object.keys(bridge).toSorted()).toEqual([...Object.keys(rows), "onState", "updateApprovalVersion"].toSorted());
  // 2: the request names `target` (a commit or an installed copy's version and list), not `targetCommit`.
  expect(bridge.updateApprovalVersion).toBe(2);
});

it.each(Object.entries(rows))("%s invokes its IPC channel", async (_name, [call, channel, args]) => {
  fake.invoke.mockClear();
  await call(bridge);
  expect(fake.invoke.mock.calls).toEqual([[channel, ...args]]);
});

it("getServerUrl gives the ready server's URL and null otherwise", async () => {
  fake.invoke.mockResolvedValueOnce({ status: "ready", serverUrl: "ws://127.0.0.1:1/ws?token=t" });
  await expect(bridge.getServerUrl()).resolves.toBe("ws://127.0.0.1:1/ws?token=t");
  fake.invoke.mockResolvedValueOnce({ status: "starting" });
  await expect(bridge.getServerUrl()).resolves.toBeNull();
});

it("onState listens on the state channel and unsubscribes the same handler", () => {
  const listener = vi.fn();
  const stop = bridge.onState(listener);
  expect(fake.on).toHaveBeenCalledWith(IPC.state, expect.any(Function));
  const handler = fake.on.mock.calls[0]![1] as (event: unknown, state: unknown) => void;
  handler({}, { status: "ready" });
  expect(listener).toHaveBeenCalledWith({ status: "ready" });
  stop();
  expect(fake.removeListener).toHaveBeenCalledWith(IPC.state, handler);
});
