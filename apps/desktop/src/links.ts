import { externalUrl } from "./client-protocol.ts";

export interface LinkDeps {
  isClientUrl(url: string): boolean;
  openExternal(url: string): Promise<void>;
  log(line: string): void;
  pagePort(): number | undefined;
}

export interface FrameNavigation {
  readonly url: string;
  readonly isMainFrame: boolean;
  readonly initiator?: { readonly parent: unknown } | null;
  preventDefault(): void;
}

export const PAGE_WINDOW = {
  width: 900,
  height: 700,
  autoHideMenuBar: true,
  backgroundColor: "#0f0f0f",
  webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false },
} as const;

export type WindowOpen = { action: "deny" } | { action: "allow"; overrideBrowserWindowOptions: typeof PAGE_WINDOW };

export interface GuardedContents {
  setWindowOpenHandler(handler: (details: { url: string }) => WindowOpen): void;
  on(event: "will-navigate", listener: (event: { preventDefault(): void }, url: string) => void): unknown;
  on(event: "will-frame-navigate", listener: (details: FrameNavigation) => void): unknown;
  on(event: "did-create-window", listener: (window: { webContents: GuardedContents }) => void): unknown;
  setWebRTCIPHandlingPolicy(policy: "disable_non_proxied_udp"): void;
}

export function isPageFrame(url: string, port?: number): boolean {
  const at = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/pages\/[0-9a-f]{32}$/.exec(url);
  return at !== null && (port === undefined || Number(at[1]) === port);
}

export function openOutside(url: string, deps: Pick<LinkDeps, "openExternal" | "log">): void {
  const target = externalUrl(url);
  if (target === null) {
    deps.log(`blocked a link that is not an http(s) page without credentials (${schemeOf(url)})`);
    return;
  }
  const origin = new URL(target).origin;
  deps.openExternal(target).catch((error: unknown) => deps.log(`the system browser did not open a link to ${origin} (${errorName(error)})`));
}

function schemeOf(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return "not a URL";
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function guardNavigation(contents: GuardedContents, deps: LinkDeps): void {
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  contents.setWindowOpenHandler(({ url }) => {
    if (url === "" || url === "about:blank") return { action: "allow", overrideBrowserWindowOptions: PAGE_WINDOW };
    openOutside(url, deps);
    return { action: "deny" };
  });
  contents.on("did-create-window", (child) => guardNavigation(child.webContents, deps));
  contents.on("will-navigate", (event, url) => {
    if (deps.isClientUrl(url)) return;
    event.preventDefault();
    openOutside(url, deps);
  });
  contents.on("will-frame-navigate", (details) => {
    if (details.isMainFrame) return;
    const fromWindow = details.initiator === undefined || details.initiator === null || details.initiator.parent === null;
    const port = deps.pagePort();
    if (port !== undefined && isPageFrame(details.url, port) && fromWindow) return;
    details.preventDefault();
    deps.log(`refused a navigation inside a frame (${schemeOf(details.url)})`);
  });
}
