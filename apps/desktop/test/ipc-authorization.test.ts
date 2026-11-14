// Exercise main's registered handlers without opening Electron or a server.
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { IPC } from "../src/bridge.ts";

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown) => unknown>();
  const window = {
    destroyed: false,
    webContents: { mainFrame: {}, on() {}, setWindowOpenHandler() {}, setWebRTCIPHandlingPolicy() {}, send() {} },
    isDestroyed() { return this.destroyed; },
    on() {},
  };
  return { handlers, window, BrowserWindow: function BrowserWindow() { return window; } };
});
vi.mock("electron", () => ({
  app: { setName() {}, setPath() {}, getPath: () => "unused", requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), on() {}, isPackaged: false },
  BrowserWindow: electron.BrowserWindow,
  ipcMain: { handle: (name: string, callback: (event: unknown) => unknown) => electron.handlers.set(name, callback) },
  protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  Menu: { setApplicationMenu() {} },
  session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
  shell: {}, clipboard: {}, net: {},
}));
vi.mock("../src/running.ts", () => ({ writeRunning() {}, clearRunning() {} }));
vi.mock("../src/supervisor.ts", () => ({
  Supervisor: class { state = { status: "idle" }; subscribe() {} start() {} killNow() {} },
}));

afterEach(() => vi.unstubAllGlobals());

it("privileged IPC accepts only the live window's main frame", async () => {
  // Main installs lifecycle listeners. Keep this bootstrap isolated from the worker.
  const lifecycle = new EventEmitter();
  vi.stubGlobal("process", new Proxy(process, {
    get(target, key) { return key === "on" ? lifecycle.on.bind(lifecycle) : Reflect.get(target, key); },
  }));
  vi.stubGlobal("__dirname", import.meta.dirname);
  await import("../src/main.ts");
  await Promise.resolve();
  const invoke = (channel: string, sender: unknown, senderFrame: unknown) => {
    const handler = electron.handlers.get(channel);
    if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
    return handler({ sender, senderFrame });
  };
  const { webContents } = electron.window;
  expect(invoke(IPC.getState, webContents, webContents.mainFrame)).toEqual({ status: "idle" });
  const channels = Object.values(IPC).filter(channel => channel !== IPC.state);
  expect([...electron.handlers.keys()].toSorted()).toEqual([...channels].toSorted());
  for (const channel of channels) {
    for (const [sender, frame] of [[{}, webContents.mainFrame], [webContents, {}], [webContents, null]]) {
      await expect(async () => invoke(channel, sender, frame), channel).rejects.toThrow("refused");
    }
    electron.window.destroyed = true;
    await expect(async () => invoke(channel, webContents, webContents.mainFrame), channel).rejects.toThrow("refused");
    electron.window.destroyed = false;
  }
});
