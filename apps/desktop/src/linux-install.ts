// Installs the Gates Local launcher and icon for one Linux user, so the app
// menu lists it and the window shows its own icon. scripts/install-linux.ts
// is the command line.
//
// A file already there with other content is moved, never overwritten or
// deleted, into a backup folder this run reserves with mkdtemp:
// $XDG_DATA_HOME/gates-local-install-backups/<time>-<random>/<same path>.
// The folder is outside applications/ and icons/, so neither the app menu
// nor the icon theme reads an old copy, and two installs never share one.
// A path counts as taken by lstat, so a symlink (even a dangling one) is
// moved as the link itself and never followed. New files are created
// exclusively ("wx"): when an overlapping install wrote the launcher after
// this run checked, that file is moved to the backup folder too, and a
// second collision stops the install instead of overwriting anything.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync, type Stats } from "node:fs";
import path from "node:path";
import { DESKTOP_ID, renderDesktopEntry } from "./desktop-entry.ts";

export const BACKUP_DIR = "gates-local-install-backups";

/** $XDG_DATA_HOME when it is absolute; the spec says a relative one is invalid and ignored. */
export function linuxDataHome(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const xdg = env["XDG_DATA_HOME"];
  return xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".local", "share");
}

export interface InstallOptions {
  /** Absolute. */
  dataHome: string;
  exec: readonly string[];
  /** The folder holding icon.svg and icon.png. */
  assets: string;
  now: Date;
  log(line: string): void;
}

export function installLinux(o: InstallOptions): void {
  if (!path.isAbsolute(o.dataHome)) throw new Error(`data home must be absolute: ${o.dataHome}`);
  // Everything is read and rendered before the first write, so a missing
  // icon or a bad Exec leaves no partial install.
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

  /** Moves whatever is at target (file, link or folder; a link is never followed) into this run's backup folder. */
  const keep = (rel: string, target: string): void => {
    const base = path.join(backupFolder(), rel);
    mkdirSync(path.dirname(base), { recursive: true });
    // The folder is this run's own (mkdtemp), so a free name stays free.
    let backup = base;
    for (let i = 1; occupied(backup); i++) backup = `${base}.${i}`;
    try {
      renameSync(target, backup);
    } catch (error) {
      // Another install moved it first and keeps its own copy.
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
    // Exclusive create: a file another install wrote since the check is
    // moved to the backup folder, never truncated. A second loss stops.
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

/** Writes a new file; false when something (a file, or a link even if dangling) already holds the name. */
function createOnly(file: string, bytes: Buffer): boolean {
  try {
    writeFileSync(file, bytes, { mode: 0o644, flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}
