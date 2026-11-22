import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync, type Stats } from "node:fs";
import path from "node:path";
import { DESKTOP_ID, renderDesktopEntry } from "./desktop-entry.ts";

export const BACKUP_DIR = "gates-local-install-backups";

declare const checked: unique symbol;
// why: installLinux takes only this, so a relative path cannot write under the working folder
export type DataHome = string & { readonly [checked]: true };

export function absoluteDataHome(dir: string): DataHome {
  if (!path.isAbsolute(dir)) throw new Error(`data home must be absolute: ${dir}`);
  return dir as DataHome;
}

export function linuxDataHome(env: Readonly<Record<string, string | undefined>>, home: string): DataHome {
  const xdg = env["XDG_DATA_HOME"];
  return absoluteDataHome(xdg && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(home, ".local", "share"));
}

export interface InstallOptions {
  dataHome: DataHome;
  exec: readonly string[];
  assets: string;
  now: Date;
  log(line: string): void;
}

export function installLinux(o: InstallOptions): void {
  const plan: Array<{ rel: string; bytes: Buffer }> = [{ rel: path.join("applications", `${DESKTOP_ID}.desktop`), bytes: Buffer.from(renderDesktopEntry(o.exec)) }];
  for (const [dir, ext] of [["scalable", "svg"], ["512x512", "png"]] as const) {
    const source = path.join(o.assets, `icon.${ext}`);
    if (!existsSync(source)) throw new Error(`missing icon source ${source}; nothing was installed`);
    plan.push({ rel: path.join("icons", "hicolor", dir, "apps", `${DESKTOP_ID}.${ext}`), bytes: readFileSync(source) });
  }

  let backups: string | null = null;
  const backupFolder = (): string => {
    if (backups !== null) return backups;
    const parent = path.join(o.dataHome, BACKUP_DIR);
    mkdirSync(parent, { recursive: true });
    backups = mkdtempSync(path.join(parent, `${o.now.toISOString().replace(/[:.]/g, "-")}-`));
    return backups;
  };

  const keep = (rel: string, target: string): void => {
    const base = path.join(backupFolder(), rel);
    mkdirSync(path.dirname(base), { recursive: true });
    // why: the folder is this run's own (mkdtemp), so a name found free stays free.
    let backup = base;
    for (let i = 1; occupied(backup); i++) backup = `${base}.${i}`;
    try {
      renameSync(target, backup);
    } catch (error) {
      // why: another install moved it first and keeps its own copy.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    o.log(`kept the old ${rel} as ${backup}`);
  };

  for (const { rel, bytes } of plan) {
    const target = path.join(o.dataHome, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    const now = lstatOrNull(target);
    if (now !== null) {
      if (now.isFile() && readFileSync(target).equals(bytes)) continue;
      keep(rel, target);
    }
    if (!createOnly(target, bytes)) {
      keep(rel, target);
      if (!createOnly(target, bytes)) throw new Error(`another install keeps writing ${target}; stopped without overwriting it (earlier copies are in ${backupFolder()})`);
    }
    o.log(`wrote ${target}`);
  }
}

function lstatOrNull(file: string): Stats | null {
  try {
    return lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const occupied = (file: string): boolean => lstatOrNull(file) !== null;

function createOnly(file: string, bytes: Buffer): boolean {
  try {
    writeFileSync(file, bytes, { mode: 0o644, flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}
