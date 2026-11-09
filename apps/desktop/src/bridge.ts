// The typed bridge between Electron main and the renderer. Pure: no Node or
// Electron imports, because the sandboxed preload bundles this file and a
// sandboxed preload cannot load Node built-ins.

import type { CrashReason, SupervisorState } from "./supervisor-state.ts";

export type { CrashReason, SupervisorState } from "./supervisor-state.ts";

/** IPC channel names. Main handles the invoke channels and sends `state`. */
export const IPC = {
  getState: "gates-local:get-state",
  restart: "gates-local:restart",
  reloadClient: "gates-local:reload-client",
  updateAndRestart: "gates-local:update-and-restart",
  dataFolder: "gates-local:data-folder",
  openDataFolder: "gates-local:open-data-folder",
  modelsFolder: "gates-local:models-folder",
  openModelsFolder: "gates-local:open-models-folder",
  state: "gates-local:state",
  titleBar: "gates-local:title-bar",
} as const;

/** The global name the preload exposes the bridge under (`window.gatesLocal`). */
export const BRIDGE_KEY = "gatesLocal";

/** What the renderer sees: the supervisor state without the server pid. */
export type BridgeState =
  | { readonly status: "idle" }
  | { readonly status: "starting"; readonly launch: number }
  | { readonly status: "restarting"; readonly launch: number }
  | {
      readonly status: "ready";
      readonly launch: number;
      readonly port: number;
      /** WebSocket URL including the per-launch token; changes on every launch. */
      readonly serverUrl: string;
    }
  | {
      readonly status: "crashed";
      readonly launch: number;
      readonly reason: CrashReason;
      readonly stderrTail: readonly string[];
      /** Epoch ms until which Restart is refused by the loop guard, or null. */
      readonly restartBlockedUntil: number | null;
    }
  | { readonly status: "stopping" }
  | { readonly status: "stopped" };

export type RestartResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not-crashed" }
  | { readonly ok: false; readonly reason: "rate-limited"; readonly retryAfterMs: number };

/** Main has started the updater and is quitting, or says in plain words why it did not. */
export type UpdateAndRestartResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** `window.gatesLocal` in the renderer. */
export interface GatesLocalBridge {
  /** Match native window controls to the renderer's resolved theme tokens. */
  syncTitleBar(colors: { color: string; symbolColor: string }): Promise<void>;
  /** Current state; resolves immediately. */
  getState(): Promise<BridgeState>;
  /** The server WebSocket URL with token when ready, else null. Ask again after every reconnect. */
  getServerUrl(): Promise<string | null>;
  /** Subscribe to state changes; returns an unsubscribe function. */
  onState(listener: (state: BridgeState) => void): () => void;
  /** Ask main to restart a crashed server. Refused unless crashed, and by the loop guard. */
  restart(): Promise<RestartResult>;
  /** Ask main to load the web client again (after a failed load). */
  reloadClient(): Promise<void>;
  /**
   * Start `pnpm run app-update` in the background and quit; it waits for this
   * app to close, updates the clone and opens the app again.
   */
  updateAndRestart(): Promise<UpdateAndRestartResult>;
  /** The folder the app keeps its data in, for Settings › Advanced. */
  dataFolder(): Promise<string>;
  /** Open that folder in the file manager; a sentence if it could not. */
  openDataFolder(): Promise<string | null>;
  /** Main's verified owned models folder; null when it is not known. */
  modelsFolder(): Promise<string | null>;
  /** Main resolves the folder again; no path crosses from the renderer. */
  openModelsFolder(): Promise<string | null>;
}

/** The one place the server URL shape is defined. */
export function serverUrl(port: number, token: string): string {
  return `ws://127.0.0.1:${port}/?token=${token}`;
}

/** Map the supervisor's internal state to what the renderer may see. */
export function toBridgeState(state: SupervisorState): BridgeState {
  switch (state.status) {
    case "ready":
      return { status: "ready", launch: state.launch, port: state.port, serverUrl: state.url };
    case "crashed":
      return {
        status: "crashed",
        launch: state.launch,
        reason: state.reason,
        stderrTail: state.stderrTail,
        restartBlockedUntil: state.restartBlockedUntil,
      };
    case "starting":
    case "restarting":
      return { status: state.status, launch: state.launch };
    case "idle":
    case "stopping":
    case "stopped":
      return { status: state.status };
  }
}

/** One human line for a crash reason, shared by the status page and logs. */
export function describeCrash(reason: CrashReason): string {
  switch (reason.kind) {
    case "exit":
      return reason.signal !== null
        ? `The server was killed by ${reason.signal}.`
        : `The server exited with code ${String(reason.code)}.`;
    case "ready-timeout":
      return `The server did not report ready within ${Math.round(reason.timeoutMs / 1000)} s.`;
    case "bad-ready":
      return `The server reported ready on the wrong port: ${reason.line}`;
    case "spawn-error":
      return `The server could not be started: ${reason.message}`;
  }
}
