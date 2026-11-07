// Public surface of @gates-local/desktop for other workspace packages: the
// renderer bridge types (window.gatesLocal). Electron main is src/main.ts.
export const DESKTOP_NAME = "gates-local-desktop";
export { BRIDGE_KEY, serverUrl } from "./bridge.ts";
export type { BridgeState, CrashReason, GatesLocalBridge, RestartResult } from "./bridge.ts";
