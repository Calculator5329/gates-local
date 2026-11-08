// Installs the Gates Local launcher and icon for one Linux user, so the app
// menu lists it and the window shows its own icon. scripts/install-linux.ts
// is the command line.
//
// A file already there with other content is moved, never overwritten or
// deleted, into a backup folder this run reserves with mkdtemp:
// $XDG_DATA_HOME/gates-local-install-backups/<time>-<random>/<same path>.
// The folder is outside applications/ and icons/, so neither the app menu
// nor the icon theme reads an old copy, and two installs never share one.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

  for (const { rel, bytes } of plan) {
    const target = path.join(o.dataHome, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    if (existsSync(target)) {
      if (readFileSync(target).equals(bytes)) continue;
      const backup = path.join(backupFolder(), rel);
      mkdirSync(path.dirname(backup), { recursive: true });
      // The folder is this run's own and each path is moved once, so this never replaces a file.
      if (existsSync(backup)) throw new Error(`backup ${backup} already exists`);
      renameSync(target, backup);
      o.log(`kept the old ${rel} as ${backup}`);
    }
    writeFileSync(target, bytes, { mode: 0o644 });
    o.log(`wrote ${target}`);
  }
}
