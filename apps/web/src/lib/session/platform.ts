import { type Settings, type UpdateInstallRequest, methodNames, phoneMay } from "@gates-local/contracts";
import { syncTitleBar } from "../../app/titlebar.ts";

// why: the web app does not import the desktop package, so the preload type lives here
type BridgeState =
  | { readonly status: "ready"; readonly serverUrl: string }
  | { readonly status: "idle" | "starting" | "restarting" | "crashed" | "stopping" | "stopped" };

interface DesktopBridge {
  readonly updateApprovalVersion?: 2;
  syncTitleBar?(colors: { color: string; symbolColor: string }): Promise<void>;
  getServerUrl(): Promise<string | null>;
  onState(listener: (state: BridgeState) => void): () => void;
  updateAndRestart?(request: UpdateInstallRequest): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
  dataFolder?(): Promise<string>;
  openDataFolder?(): Promise<string | null>;
  modelsFolder?(): Promise<string | null>;
  openModelsFolder?(): Promise<string | null>;
  pickFolder?(start?: string): Promise<string | null>;
  showUpdate?(version: string): Promise<string | null>;
}

declare global {
  interface Window {
    gatesLocal?: DesktopBridge;
  }
}

export async function serverUrl(): Promise<string | null> {
  if (window.gatesLocal) return window.gatesLocal.getServerUrl();
  return webServerUrl();
}

// why: an async lookup would flash a booting screen before No Server
export function webServerUrl(): string | null {
  const fromQuery = new URLSearchParams(location.search).get("server");
  const fromEnv: unknown = import.meta.env["VITE_GATES_LOCAL_SERVER"];
  const configured = fromQuery ?? (typeof fromEnv === "string" && fromEnv !== "" ? fromEnv : null);
  if (configured !== null) return configured;
  if (onPhoneListener()) return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
  return null;
}

function onPhoneListener(): boolean {
  return document.querySelector('meta[name="gates-local-server"]')?.getAttribute("content") === "same-origin";
}

export function computerOnlyMethods(phone: boolean = onPhoneListener()): Readonly<Record<string, true>> {
  if (!phone) return {};
  return Object.fromEntries(methodNames.filter((m) => !phoneMay(m)).map((m): [string, true] => [m, true]));
}

export function fileUrl(origin: string, token: string | null, path: string): string {
  return `${origin}/files/${path.split("/").map(encodeURIComponent).join("/")}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

export function applyAccent(accent: Settings["accent"]): void {
  const root = document.documentElement;
  if (accent === undefined || accent === "neutral") root.removeAttribute("data-accent");
  else root.setAttribute("data-accent", accent);
}

export function applyTheme(theme: Settings["theme"]): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  syncTitleBar();
}

export async function dataFolder(): Promise<string | null> {
  return (await window.gatesLocal?.dataFolder?.()) ?? null;
}

export async function openDataFolder(): Promise<string | null> {
  return (await window.gatesLocal?.openDataFolder?.()) ?? null;
}

export const folderDialog = (): ((start?: string) => Promise<string | null>) | undefined => {
  const pick = window.gatesLocal?.pickFolder;
  return pick === undefined ? undefined : (start) => pick(start);
};

export const canOpenFolder = (): boolean => window.gatesLocal?.modelsFolder !== undefined && window.gatesLocal.openModelsFolder !== undefined;

export const canShowUpdate = (): boolean => typeof window.gatesLocal?.showUpdate === "function";

export async function showUpdate(version: string): Promise<string | null> {
  const show = window.gatesLocal?.showUpdate;
  return show === undefined ? "Only the desktop app can open this folder." : show(version);
}

export function canUpdateHere(): boolean {
  return window.gatesLocal?.updateApprovalVersion === 2 && typeof window.gatesLocal.updateAndRestart === "function";
}
