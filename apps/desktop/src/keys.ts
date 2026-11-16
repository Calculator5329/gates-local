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

// external: Chromium's own zoom menu steps by half a level and keeps between -3 and 4.5.
export const ZOOM_STEP = 0.5;
export const ZOOM_MIN = -3;
export const ZOOM_MAX = 4.5;

export const hidesMenu = (platform: NodeJS.Platform): boolean => platform !== "darwin";

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

export function zoomAfter(action: "zoom-in" | "zoom-out" | "zoom-reset", level: number): number {
  if (action === "zoom-in") return Math.min(ZOOM_MAX, level + ZOOM_STEP);
  if (action === "zoom-out") return Math.max(ZOOM_MIN, level - ZOOM_STEP);
  return 0;
}

export interface KeyedContents {
  on(event: "before-input-event", listener: (event: { preventDefault(): void }, input: KeyInput) => void): unknown;
  getZoomLevel(): number;
  setZoomLevel(level: number): void;
  reload(): void;
  reloadIgnoringCache(): void;
  toggleDevTools(): void;
}

export interface KeyedWindow {
  close(): void;
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
}

export interface KeyDeps {
  platform: NodeJS.Platform;
  devTools: boolean;
  quit(): void;
}

// external: Electron drops a menu's accelerators along with the menu, so with none set the keys come back here.
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
