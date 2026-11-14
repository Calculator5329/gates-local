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

/** The parts of Electron's WebContents the guard uses. */
export interface GuardedContents {
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
  on(event: "will-navigate", listener: (event: { preventDefault(): void }, url: string) => void): unknown;
  on(event: "will-frame-navigate", listener: (details: { url: string; isMainFrame: boolean; preventDefault(): void }) => void): unknown;
}

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

/** The window never opens another window or leaves the client. */
export function guardNavigation(contents: GuardedContents, deps: LinkDeps): void {
  contents.setWindowOpenHandler(({ url }) => {
    openOutside(url, deps);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (deps.isClientUrl(url)) return;
    event.preventDefault();
    openOutside(url, deps);
  });
  // A frame in the window (Measure's page checks) keeps the page it was given: it loads no address.
  contents.on("will-frame-navigate", (details) => {
    if (details.isMainFrame || details.url === "about:srcdoc" || details.url === "about:blank") return;
    details.preventDefault();
  });
}
