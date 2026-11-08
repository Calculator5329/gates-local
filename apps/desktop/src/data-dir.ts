// Where the desktop app tells the server to keep its data (`--data-dir`):
// threads, settings, snapshots, and the app's own Ollama install and models,
// which can be many GB. That is local machine data, so it never goes in the
// Electron profile on Windows (%APPDATA% roams) or ~/.config on Linux. The
// folder is the server's own default (runtime/paths.ts defaultAppDataDir),
// so the models stay where they were before each data dir got its own store.
import path from "node:path";

export type DataDirInput = {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  /** Electron's userData folder. */
  userData: string;
};

export function serverDataDir(o: DataDirInput): string {
  const pinned = o.env["GATES_LOCAL_DATA_DIR"];
  if (pinned) return pinned;
  // An isolated profile (smoke runs) keeps its data inside it.
  if (o.env["GATES_LOCAL_USER_DATA"] || o.platform === "darwin") return path.join(o.userData, "server-data");
  if (o.platform === "win32") {
    const local = o.env["LOCALAPPDATA"];
    return path.win32.join(local && path.win32.isAbsolute(local) ? local : path.win32.join(o.home, "AppData", "Local"), "GatesLocal");
  }
  const xdg = o.env["XDG_DATA_HOME"];
  return path.posix.join(xdg && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(o.home, ".local", "share"), "gates-local");
}
