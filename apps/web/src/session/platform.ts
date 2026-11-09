// Desktop bridge, server discovery and browser appearance effects.
import type { Settings } from "@gates-local/contracts";
import { syncTitleBar } from "../titlebar.ts";

// The preload's window.gatesLocal (apps/desktop/src/preload.ts). Declared here
// because the web app does not import the desktop package.
type BridgeState =
  | { readonly status: "ready"; readonly serverUrl: string }
  | { readonly status: "idle" | "starting" | "restarting" | "crashed" | "stopping" | "stopped" };

interface DesktopBridge {
  /** Native control colours, resolved from the page's theme tokens. */
  syncTitleBar?(colors: { color: string; symbolColor: string }): Promise<void>;
  getServerUrl(): Promise<string | null>;
  onState(listener: (state: BridgeState) => void): () => void;
  /** Starts `pnpm run app-update` and quits; missing on desktop builds from before it existed. */
  updateAndRestart?(): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
  /** The folder the app keeps its data in; missing on desktop builds from before it existed. */
  dataFolder?(): Promise<string>;
  /** Opens the data folder in the file manager; a sentence if it could not. */
  openDataFolder?(): Promise<string | null>;
  modelsFolder?(): Promise<string | null>;
  openModelsFolder?(): Promise<string | null>;
}

declare global {
  interface Window {
    gatesLocal?: DesktopBridge;
  }
}

/**
 * Where the server is: the desktop bridge, else ?server= or
 * VITE_GATES_LOCAL_SERVER, else this page's own host when the server served
 * the page (the phone listener injects the gates-local-server meta).
 */
export async function serverUrl(): Promise<string | null> {
  if (window.gatesLocal) return window.gatesLocal.getServerUrl();
  return webServerUrl();
}

/** Browser configuration is synchronous, so No Server can cover the first render. */
export function webServerUrl(): string | null {
  const fromQuery = new URLSearchParams(location.search).get("server");
  const fromEnv: unknown = import.meta.env["VITE_GATES_LOCAL_SERVER"];
  const configured = fromQuery ?? (typeof fromEnv === "string" && fromEnv !== "" ? fromEnv : null);
  if (configured !== null) return configured;
  if (document.querySelector('meta[name="gates-local-server"]')?.getAttribute("content") === "same-origin") {
    return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
  }
  return null;
}

/** A /files/ URL on the server; the token rides along only when the socket URL had one. */
export function fileUrl(origin: string, token: string | null, path: string): string {
  return `${origin}/files/${path.split("/").map(encodeURIComponent).join("/")}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

/** "small" or "large" on the root; the default has no attribute (styles.css --chat-fs). */
export function applyTextSize(size: Settings["textSize"]): void {
  const root = document.documentElement;
  if (size === undefined || size === "default") root.removeAttribute("data-text");
  else root.setAttribute("data-text", size);
}

/** Dark or light on the root; "system" removes the attribute so the OS decides (styles.css). */
export function applyTheme(theme: Settings["theme"]): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  syncTitleBar();
}

/** The app's data folder, or null outside the desktop window. */
export async function dataFolder(): Promise<string | null> {
  return (await window.gatesLocal?.dataFolder?.()) ?? null;
}

export async function openDataFolder(): Promise<string | null> {
  return (await window.gatesLocal?.openDataFolder?.()) ?? null;
}

/** Only the desktop window can open a folder. */
export const canOpenFolder = (): boolean => window.gatesLocal?.modelsFolder !== undefined && window.gatesLocal.openModelsFolder !== undefined;

/** True in the desktop app, which can quit, update and open again; phones and browsers only check. */
export function canUpdateHere(): boolean {
  return typeof window.gatesLocal?.updateAndRestart === "function";
}

/** The Update and restart button: the desktop starts the updater and quits; null when it is on its way. */
export async function updateAndRestart(): Promise<string | null> {
  const bridge = window.gatesLocal;
  if (bridge?.updateAndRestart === undefined) return "Updating from here needs the desktop app. Run pnpm run app-update in the Gates Local folder instead.";
  try {
    const r = await bridge.updateAndRestart();
    return r.ok ? null : r.message;
  } catch (e) {
    return `Couldn't start the update (${e instanceof Error ? e.message : String(e)}). Run pnpm run app-update in the Gates Local folder instead.`;
  }
}
