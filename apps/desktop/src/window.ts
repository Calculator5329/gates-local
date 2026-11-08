// The window's construction options, outside main.ts so the icon and the
// renderer's security settings are tested without Electron.

import type { BrowserWindowConstructorOptions } from "electron";
import path from "node:path";

/**
 * The window icon (X11, Windows, and Wayland compositors that take one); the
 * desktop entry's icon covers the rest. Packaged layout is provisional until
 * packaging lands.
 */
export function iconFile(o: { packaged: boolean; resourcesPath: string; desktopDir: string }): string {
  return o.packaged ? path.join(o.resourcesPath, "icon.png") : path.join(o.desktopDir, "assets", "icon.png");
}

export function windowOptions(o: { icon: string; preload: string }): BrowserWindowConstructorOptions {
  return {
    width: 1200,
    height: 800,
    title: "Gates Local",
    icon: o.icon,
    webPreferences: {
      preload: o.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // On by default; on Linux it downloads dictionaries from Google.
      spellcheck: false,
    },
  };
}
