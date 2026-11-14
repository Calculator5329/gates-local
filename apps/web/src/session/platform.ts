// Desktop bridge, server discovery and browser appearance effects.
import { type Settings, type UpdateInstallRequest, methodNames, phoneMay } from "@gates-local/contracts";
import { syncTitleBar } from "../titlebar.ts";

// The preload's window.gatesLocal (apps/desktop/src/preload.ts). Declared here
// because the web app does not import the desktop package.
type BridgeState =
  | { readonly status: "ready"; readonly serverUrl: string }
  | { readonly status: "idle" | "starting" | "restarting" | "crashed" | "stopping" | "stopped" };

interface DesktopBridge {
  readonly updateApprovalVersion?: 2;
  /** Native control colours, resolved from the page's theme tokens. */
  syncTitleBar?(colors: { color: string; symbolColor: string }): Promise<void>;
  getServerUrl(): Promise<string | null>;
  onState(listener: (state: BridgeState) => void): () => void;
  /** Starts `pnpm run app-update` and quits; missing on desktop builds from before it existed. */
  updateAndRestart?(request: UpdateInstallRequest): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
  /** The folder the app keeps its data in; missing on desktop builds from before it existed. */
  dataFolder?(): Promise<string>;
  /** Opens the data folder in the file manager; a sentence if it could not. */
  openDataFolder?(): Promise<string | null>;
  modelsFolder?(): Promise<string | null>;
  openModelsFolder?(): Promise<string | null>;
  /** The system's folder dialog, opened at `start`; null when the person closed it. Missing on older desktop builds. */
  pickFolder?(start?: string): Promise<string | null>;
  /** Shows a downloaded, checked update in the file manager; a sentence if it could not. Missing on older desktop builds. */
  showUpdate?(version: string): Promise<string | null>;
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
  if (onPhoneListener()) return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
  return null;
}

/** Only the phone listener injects this meta; a phone-sized window on the computer does not have it. */
function onPhoneListener(): boolean {
  return document.querySelector('meta[name="gates-local-server"]')?.getAttribute("content") === "same-origin";
}

/** What the phone listener refuses, marked unavailable before the first render so no control offers it. */
export function computerOnlyMethods(phone: boolean = onPhoneListener()): Readonly<Record<string, true>> {
  if (!phone) return {};
  return Object.fromEntries(methodNames.filter((m) => !phoneMay(m)).map((m): [string, true] => [m, true]));
}

/** A /files/ URL on the server; the token rides along only when the socket URL had one. */
export function fileUrl(origin: string, token: string | null, path: string): string {
  return `${origin}/files/${path.split("/").map(encodeURIComponent).join("/")}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

/** A colour on the root; Neutral has no attribute, so --accent stays the theme foreground (styles.css). */
export function applyAccent(accent: Settings["accent"]): void {
  const root = document.documentElement;
  if (accent === undefined || accent === "neutral") root.removeAttribute("data-accent");
  else root.setAttribute("data-accent", accent);
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

/** The desktop window's folder dialog, or undefined where there is none (a browser, a phone): a path field then. */
export const folderDialog = (): ((start?: string) => Promise<string | null>) | undefined => {
  const pick = window.gatesLocal?.pickFolder;
  return pick === undefined ? undefined : (start) => pick(start);
};

/** Only the desktop window can open a folder. */
export const canOpenFolder = (): boolean => window.gatesLocal?.modelsFolder !== undefined && window.gatesLocal.openModelsFolder !== undefined;

/** The desktop window can show a downloaded update's file in its folder (a copy that cannot install it by itself). */
export const canShowUpdate = (): boolean => typeof window.gatesLocal?.showUpdate === "function";

/** Shows a downloaded update's file in the file manager; a sentence if it could not. */
export async function showUpdate(version: string): Promise<string | null> {
  const show = window.gatesLocal?.showUpdate;
  return show === undefined ? "Only the desktop app can open this folder." : show(version);
}

/** True in the desktop app, which can quit, update and open again; phones and browsers only check. */
export function canUpdateHere(): boolean {
  return window.gatesLocal?.updateApprovalVersion === 2 && typeof window.gatesLocal.updateAndRestart === "function";
}
