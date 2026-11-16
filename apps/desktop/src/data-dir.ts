import path from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import type { OwnershipCheck } from "@gates-local/runtime-files/ownership";

export type DataDirInput = {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  userData: string;
  packaged?: boolean;
};

export function desktopUserDataDir(o: {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  appData: string;
  packaged: boolean;
}): string {
  const paths = o.platform === "win32" ? path.win32 : path.posix;
  return o.env["GATES_LOCAL_USER_DATA"] ?? paths.join(o.appData, o.packaged ? "gates-local-installed" : "gates-local");
}

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
  if (o.env["GATES_LOCAL_USER_DATA"] || o.platform === "darwin") return (o.platform === "win32" ? path.win32 : path.posix).join(o.userData, "server-data");
  if (o.platform === "win32") {
    const local = o.env["LOCALAPPDATA"];
    return path.win32.join(local && path.win32.isAbsolute(local) ? local : path.win32.join(o.home, "AppData", "Local"), o.packaged ? "GatesLocalInstalled" : "GatesLocal");
  }
  const xdg = o.env["XDG_DATA_HOME"];
  return path.posix.join(xdg && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(o.home, ".local", "share"), o.packaged ? "gates-local-installed" : "gates-local");
}
