// Where the desktop app tells the server to keep its data (`--data-dir`):
// threads, settings, snapshots, the Ollama ownership record and serve log.
// The app's own Ollama install and its models (many GB) live in the server's
// store under this same data directory. Packaged defaults use a separate
// sibling of the clone's store. Both are local machine data, so neither goes
// in the Electron profile on Windows (%APPDATA% roams) or ~/.config on Linux.
import path from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import type { OwnershipCheck } from "../../server/src/runtime/ownership.ts";

export type DataDirInput = {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  /** Electron's userData folder. */
  userData: string;
  /** Omitted by clone-only commands, which keep their existing defaults. */
  packaged?: boolean;
};

/** Resolve the profile before Electron takes its profile-scoped instance lock. */
export function desktopUserDataDir(o: {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  appData: string;
  packaged: boolean;
}): string {
  const paths = o.platform === "win32" ? path.win32 : path.posix;
  return o.env["GATES_LOCAL_USER_DATA"] ?? paths.join(o.appData, o.packaged ? "gates-local-installed" : "gates-local");
}

/** Main owns the lookup and rechecks it on Open; the renderer supplies no path. */
export function modelFolderActions(o: {
  ownership(): OwnershipCheck;
  isFolder(folder: string): boolean;
  openPath(folder: string): Promise<string>;
}) {
  const modelsFolder = (): string | null => {
    const owned = o.ownership();
    const folder = owned.kind === "ours" ? owned.record.modelsDir : undefined;
    if (folder === undefined || !path.isAbsolute(folder)) return null;
    try {
      // Process ownership alone cannot authorize a substituted symlink or an aliased parent.
      return o.isFolder(folder) && lstatSync(folder).isDirectory() && realpathSync(folder) === path.resolve(folder) ? folder : null;
    } catch {
      return null;
    }
  };
  const openModelsFolder = async (): Promise<string | null> => {
    const folder = modelsFolder();
    if (folder === null) return null;
    const error = await o.openPath(folder);
    return error === "" ? null : `Couldn't open the folder: ${error}`;
  };
  return { modelsFolder, openModelsFolder };
}

export function serverDataDir(o: DataDirInput): string {
  const pinned = o.env["GATES_LOCAL_DATA_DIR"];
  if (pinned) return pinned;
  // An isolated profile (smoke runs) keeps its data inside it.
  if (o.env["GATES_LOCAL_USER_DATA"] || o.platform === "darwin") return (o.platform === "win32" ? path.win32 : path.posix).join(o.userData, "server-data");
  if (o.platform === "win32") {
    const local = o.env["LOCALAPPDATA"];
    return path.win32.join(local && path.win32.isAbsolute(local) ? local : path.win32.join(o.home, "AppData", "Local"), o.packaged ? "GatesLocalInstalled" : "GatesLocal");
  }
  const xdg = o.env["XDG_DATA_HOME"];
  return path.posix.join(xdg && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(o.home, ".local", "share"), o.packaged ? "gates-local-installed" : "gates-local");
}
