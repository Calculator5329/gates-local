// What the window does with a link: a page of the client stays in the
// window, a web page opens in the system browser, anything else is dropped.
// Electron is passed in (the parts of WebContents and shell this needs), so
// the handlers are tested without it.

import { externalUrl } from "./client-protocol.ts";

export interface LinkDeps {
  isClientUrl(url: string): boolean;
  openExternal(url: string): Promise<void>;
  log(line: string): void;
}

/** A navigation in any frame of the window, as Electron's will-frame-navigate gives it. */
export interface FrameNavigation {
  readonly url: string;
  readonly isMainFrame: boolean;
  /** The frame that asked for it: the window's own document has no parent. */
  readonly initiator?: { readonly parent: unknown } | null;
  preventDefault(): void;
}

/** A page's own window (apps/web/src/pages): a blank window of the client's, as locked as this one. */
export const PAGE_WINDOW = {
  width: 900,
  height: 700,
  autoHideMenuBar: true,
  backgroundColor: "#0f0f0f",
  webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false },
} as const;

export type WindowOpen = { action: "deny" } | { action: "allow"; overrideBrowserWindowOptions: typeof PAGE_WINDOW };

/** The parts of Electron's WebContents the guard uses. */
export interface GuardedContents {
  setWindowOpenHandler(handler: (details: { url: string }) => WindowOpen): void;
  on(event: "will-navigate", listener: (event: { preventDefault(): void }, url: string) => void): unknown;
  on(event: "will-frame-navigate", listener: (details: FrameNavigation) => void): unknown;
  on(event: "did-create-window", listener: (window: { webContents: GuardedContents }) => void): unknown;
  setWebRTCIPHandlingPolicy(policy: "disable_non_proxied_udp"): void;
}

/** The one kind of address a frame in the window may load: a page a reply wrote, as the client frames it. */
const isPageFrame = (url: string): boolean => /^data:text\/html[;,]/i.test(url);

/**
 * Hand an http(s) link to the system browser; any other URL is dropped.
 * A link can carry a password or a token, so a log line names at most the
 * scheme of a refused link and the origin of an accepted one, never the
 * rest of the URL or the shell's error text (which can repeat it).
 */
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

/**
 * The window never leaves the client, and opens no other window but a blank
 * one the client fills with a page (guarded the same way). A frame inside it
 * loads only a page the window itself put there: a page cannot move its own
 * frame anywhere. WebRTC gets no direct route out.
 */
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
    // the window's own document is will-navigate's
    if (details.isMainFrame) return;
    // A blank frame stays blank. Pages and Measure's page checks load as data: pages (below); no
    // frame is a srcdoc one any more, so about:srcdoc is refused like any other address.
    if (details.url === "about:blank") return;
    const fromWindow = details.initiator === undefined || details.initiator === null || details.initiator.parent === null;
    if (isPageFrame(details.url) && fromWindow) return;
    details.preventDefault();
    deps.log(`refused a navigation inside a frame (${schemeOf(details.url)})`);
  });
}
