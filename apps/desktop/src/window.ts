// Adapts apps/desktop/src/window/DesktopWindow.ts in T3 Code (MIT),
// commit d137c5081ac5efb2b8ea9aec8b334e1bb4d0182a.
// The window's construction options, outside main.ts so the icon and the
// renderer's security settings are tested without Electron.

import type { BrowserWindowConstructorOptions } from "electron";
import path from "node:path";

// external: X11, Windows and some Wayland compositors take a window icon; the rest use the desktop entry's.
export function iconFile(o: { packaged: boolean; resourcesPath: string; desktopDir: string }): string {
  return o.packaged ? path.join(o.resourcesPath, "icon.png") : path.join(o.desktopDir, "assets", "icon.png");
}

export function windowOptions(o: { icon: string; preload: string; platform?: NodeJS.Platform }): BrowserWindowConstructorOptions {
  return {
    width: 1200,
    height: 800,
    title: "Gates Local",
    icon: o.icon,
    titleBarStyle: (o.platform ?? process.platform) === "darwin" ? "hiddenInset" : "hidden",
    titleBarOverlay: { height: 52 },
    ...((o.platform ?? process.platform) === "darwin" ? { trafficLightPosition: { x: 16, y: 18 } } : {}),
    webPreferences: {
      preload: o.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // external: Electron's spellcheck is on by default, and on Linux it downloads dictionaries from Google.
      spellcheck: false,
    },
  };
}
