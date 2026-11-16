import type { CrashReason, SupervisorState } from "./supervisor-state.ts";
import type { UpdateInstallRequest } from "@gates-local/contracts";

export type { CrashReason, SupervisorState } from "./supervisor-state.ts";

export const IPC = {
  getState: "gates-local:get-state",
  restart: "gates-local:restart",
  reloadClient: "gates-local:reload-client",
  updateAndRestart: "gates-local:install-approved-update",
  dataFolder: "gates-local:data-folder",
  openDataFolder: "gates-local:open-data-folder",
  modelsFolder: "gates-local:models-folder",
  openModelsFolder: "gates-local:open-models-folder",
  pickFolder: "gates-local:pick-folder",
  showUpdate: "gates-local:show-update",
  state: "gates-local:state",
  titleBar: "gates-local:title-bar",
} as const;

export const BRIDGE_KEY = "gatesLocal";

export type BridgeState =
  | { readonly status: "idle" }
  | { readonly status: "starting"; readonly launch: number }
  | { readonly status: "restarting"; readonly launch: number }
  | {
      readonly status: "ready";
      readonly launch: number;
      readonly port: number;
      readonly serverUrl: string;
      // external: Chromium's sandbox is off under the AppImage launcher's --no-sandbox.
      readonly sandboxOff?: true;
    }
  | {
      readonly status: "crashed";
      readonly launch: number;
      readonly reason: CrashReason;
      readonly stderrTail: readonly string[];
      readonly exit?: { readonly code: number | null; readonly signal: string | null } | null;
      readonly logPath?: string;
      readonly restartBlockedUntil: number | null;
    }
  | { readonly status: "stopping" }
  | { readonly status: "stopped" };

export type RestartResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not-crashed" }
  | { readonly ok: false; readonly reason: "rate-limited"; readonly retryAfterMs: number };

export type UpdateAndRestartResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

export interface GatesLocalBridge {
  readonly updateApprovalVersion: 2;
  syncTitleBar(colors: { color: string; symbolColor: string }): Promise<void>;
  getState(): Promise<BridgeState>;
  getServerUrl(): Promise<string | null>;
  onState(listener: (state: BridgeState) => void): () => void;
  restart(): Promise<RestartResult>;
  reloadClient(): Promise<void>;
  updateAndRestart(request: UpdateInstallRequest): Promise<UpdateAndRestartResult>;
  dataFolder(): Promise<string>;
  openDataFolder(): Promise<string | null>;
  modelsFolder(): Promise<string | null>;
  openModelsFolder(): Promise<string | null>;
  pickFolder(start?: string): Promise<string | null>;
  showUpdate(version: string): Promise<string | null>;
}

export function serverUrl(port: number, token: string): string {
  return `ws://127.0.0.1:${port}/?token=${token}`;
}

export function toBridgeState(state: SupervisorState, sandboxOff = false): BridgeState {
  switch (state.status) {
    case "ready":
      return { status: "ready", launch: state.launch, port: state.port, serverUrl: state.url, ...(sandboxOff ? { sandboxOff: true } : {}) };
    case "crashed":
      return {
        status: "crashed",
        launch: state.launch,
        reason: state.reason,
        stderrTail: state.stderrTail,
        ...(state.exit === undefined ? {} : { exit: state.exit }),
        ...(state.logPath === undefined ? {} : { logPath: state.logPath }),
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
