// Keep Electron's main-process types resolved beside the desktop dependency.
export type DesktopApi = typeof import("electron");
