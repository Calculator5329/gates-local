// Sandboxed preload: exposes window.gatesLocal (GatesLocalBridge) and nothing
// else. Bundled to out/preload.cjs; may import only bridge.ts and electron.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { BRIDGE_KEY, IPC, type BridgeState, type GatesLocalBridge, type RestartResult, type UpdateAndRestartResult } from "./bridge.ts";

const bridge: GatesLocalBridge = {
  updateApprovalVersion: 1,
  syncTitleBar: async (colors) => { await ipcRenderer.invoke(IPC.titleBar, colors); },
  getState: async () => (await ipcRenderer.invoke(IPC.getState)) as BridgeState,
  getServerUrl: async () => {
    const state = (await ipcRenderer.invoke(IPC.getState)) as BridgeState;
    return state.status === "ready" ? state.serverUrl : null;
  },
  onState: (listener) => {
    const handler = (_event: IpcRendererEvent, state: BridgeState) => listener(state);
    ipcRenderer.on(IPC.state, handler);
    return () => {
      ipcRenderer.removeListener(IPC.state, handler);
    };
  },
  restart: async () => (await ipcRenderer.invoke(IPC.restart)) as RestartResult,
  reloadClient: async () => {
    await ipcRenderer.invoke(IPC.reloadClient);
  },
  updateAndRestart: async (request) => (await ipcRenderer.invoke(IPC.updateAndRestart, request)) as UpdateAndRestartResult,
  dataFolder: async () => (await ipcRenderer.invoke(IPC.dataFolder)) as string,
  openDataFolder: async () => (await ipcRenderer.invoke(IPC.openDataFolder)) as string | null,
  modelsFolder: async () => (await ipcRenderer.invoke(IPC.modelsFolder)) as string | null,
  openModelsFolder: async () => (await ipcRenderer.invoke(IPC.openModelsFolder)) as string | null,
};

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge);
