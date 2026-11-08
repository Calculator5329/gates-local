// Window keys the default menu used to give. Linux and Windows run with no
// application menu at all (Ethan, 2026-11-07: no File/Edit/View/Window bar),
// and Electron drops a menu's accelerators with it, so the keys come back
// here, on before-input-event. There is no hidden menu: with none set,
// nothing (Alt, autoHideMenuBar, a global menu bar) can show one again.
// Copy, paste, select-all and undo are Chromium's own editing keys outside
// macOS and are left to the page. macOS keeps its default menu.
// Electron is passed in (the parts of WebContents and BrowserWindow this
// needs), so the handler is tested without it.

/** The parts of Electron's Input this reads. */
export interface KeyInput {
  readonly type: string;
  readonly key: string;
  readonly control: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly isAutoRepeat?: boolean;
  readonly isComposing?: boolean;
}

export type WindowAction = "reload" | "force-reload" | "close" | "quit" | "fullscreen" | "devtools" | "zoom-in" | "zoom-out" | "zoom-reset";

/** One zoom step per press, and the bounds Chromium's own zoom menu keeps. */
export const ZOOM_STEP = 0.5;
export const ZOOM_MIN = -3;
export const ZOOM_MAX = 4.5;

/** Linux and Windows get no menu bar; macOS keeps its default menu (its Edit menu carries copy and paste). */
export const hidesMenu = (platform: NodeJS.Platform): boolean => platform !== "darwin";

/**
 * The window action for a key, with the accelerators Electron's default
 * menu roles use on Linux and Windows: Ctrl+R reload, Ctrl+Shift+R reload
 * without the cache, Ctrl+W close, Ctrl+Q quit (Linux only, as the quit
 * role), F11 full screen, Ctrl+Shift+I dev tools (when allowed), Ctrl with
 * = or +, - or _, and 0 for zoom. Never with Alt or the Super key, never
 * mid-composition (IME), and a held key repeats only zoom.
 */
export function windowAction(input: KeyInput, platform: NodeJS.Platform, opts: { devTools: boolean }): WindowAction | null {
  if (!hidesMenu(platform) || input.type !== "keyDown" || input.alt || input.meta || input.isComposing === true) return null;
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  if (!input.control) return key === "F11" && !input.shift && input.isAutoRepeat !== true ? "fullscreen" : null;
  switch (key) {
    case "=":
    case "+":
      return "zoom-in";
    case "-":
    case "_":
      return "zoom-out";
    case "0":
      return "zoom-reset";
  }
  if (input.isAutoRepeat === true) return null;
  switch (key) {
    case "r":
      return input.shift ? "force-reload" : "reload";
    case "w":
      return input.shift ? null : "close";
    case "q":
      return platform === "linux" && !input.shift ? "quit" : null;
    case "i":
      return input.shift && opts.devTools ? "devtools" : null;
    default:
      return null;
  }
}

/** The zoom level after a zoom action. */
export function zoomAfter(action: "zoom-in" | "zoom-out" | "zoom-reset", level: number): number {
  if (action === "zoom-in") return Math.min(ZOOM_MAX, level + ZOOM_STEP);
  if (action === "zoom-out") return Math.max(ZOOM_MIN, level - ZOOM_STEP);
  return 0;
}

/** The parts of Electron's WebContents the keys use. */
export interface KeyedContents {
  on(event: "before-input-event", listener: (event: { preventDefault(): void }, input: KeyInput) => void): unknown;
  getZoomLevel(): number;
  setZoomLevel(level: number): void;
  reload(): void;
  reloadIgnoringCache(): void;
  toggleDevTools(): void;
}

/** The parts of Electron's BrowserWindow the keys use. */
export interface KeyedWindow {
  close(): void;
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
}

export interface KeyDeps {
  platform: NodeJS.Platform;
  /** Dev tools only in an unpackaged (development) run. */
  devTools: boolean;
  quit(): void;
}

/** Registers the window keys on Linux and Windows; does nothing on macOS, whose menu has them. */
export function installWindowKeys(window: KeyedWindow, contents: KeyedContents, deps: KeyDeps): void {
  if (!hidesMenu(deps.platform)) return;
  contents.on("before-input-event", (event, input) => {
    const action = windowAction(input, deps.platform, { devTools: deps.devTools });
    if (action === null) return;
    event.preventDefault();
    switch (action) {
      case "zoom-in":
      case "zoom-out":
      case "zoom-reset":
        contents.setZoomLevel(zoomAfter(action, contents.getZoomLevel()));
        return;
      case "reload":
        contents.reload();
        return;
      case "force-reload":
        contents.reloadIgnoringCache();
        return;
      case "close":
        window.close();
        return;
      case "quit":
        deps.quit();
        return;
      case "fullscreen":
        window.setFullScreen(!window.isFullScreen());
        return;
      case "devtools":
        contents.toggleDevTools();
        return;
    }
  });
}
