import { chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, openSync, readdirSync, unlinkSync, type Stats } from "node:fs";
import path from "node:path";

/**
 * A folder of the app's, held so that nothing done in it follows a link out.
 *
 * On Linux it is an open handle (O_DIRECTORY | O_NOFOLLOW) and every name below it resolves
 * through /proc/self/fd/<n>/<name>: the kernel walks into that very folder, so swapping the
 * folder's path for a link afterwards changes nothing. Entries are opened with O_NOFOLLOW and
 * chmodded through their own handle. Before anything is changed, `placed()` checks that the
 * folder is still where it was opened, all the way up to the root folder.
 *
 * Elsewhere (Windows, or a Linux with no /proc) names resolve by path and only lstat checks
 * protect them: a link that is there is refused, a link swapped in between the check and the
 * operation is not.
 */
export interface Dir {
  /** The host path it was opened at, for messages. */
  readonly path: string;
  /** A path to `name` inside this folder. */
  at(name: string): string;
  names(): string[];
  /** lstat of `name` inside this folder; undefined when nothing is there. */
  lstat(name: string): Stats | undefined;
  /** This folder, and each folder it was opened from, is still at the path it was opened at. */
  placed(): boolean;
  chmod(mode: number): void;
  close(): void;
}
/** A folder or a regular file, opened without following a link. */
export interface Entry {
  readonly stat: Stats;
  /** Set when the entry is a folder. */
  readonly dir?: Dir;
  chmod(mode: number): void;
  close(): void;
}

/** lstat, or undefined when nothing is there: a link is reported as itself, never followed. */
export function lstatIfAny(file: string): Stats | undefined {
  try { return lstatSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
}
/** The same file: same device and inode. */
export function sameFile(a: Stats | undefined, b: Stats | undefined): boolean {
  return a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino;
}
/** Removes `name` from `dir` (a link is removed as itself); nothing there is fine. */
export function unlinkIfAny(dir: Dir, name: string): void {
  try { unlinkSync(dir.at(name)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
}

const handles = (platform: NodeJS.Platform) => platform === "linux" && existsSync("/proc/self/fd");
// Gone, a link, not a folder, a socket, or unreadable (a file this user cannot read is private already).
const SKIPPED = new Set(["ENOENT", "ELOOP", "ENOTDIR", "ENXIO", "EACCES"]);
const tryOpen = (file: string, flags: number) => {
  try { return openSync(file, flags); } catch (e) { if (SKIPPED.has((e as NodeJS.ErrnoException).code ?? "")) return undefined; throw e; }
};

function handleDir(fd: number, at: string, placedAbove: () => boolean, here: () => Stats | undefined): Dir {
  const self = `/proc/self/fd/${fd}`;
  return {
    path: at,
    at: name => `${self}/${name}`,
    names: () => readdirSync(self),
    lstat: name => lstatIfAny(`${self}/${name}`),
    placed: () => placedAbove() && sameFile(here(), fstatSync(fd)),
    chmod: mode => fchmodSync(fd, mode),
    close: () => closeSync(fd),
  };
}
function pathDir(at: string, placedAbove: () => boolean): Dir {
  return {
    path: at,
    at: name => path.join(at, name),
    names: () => readdirSync(at),
    lstat: name => lstatIfAny(path.join(at, name)),
    placed: () => placedAbove() && lstatIfAny(at)?.isDirectory() === true,
    chmod: mode => chmodSync(at, mode),
    close: () => undefined,
  };
}

/** The real folder at `file`, or undefined when there is none there (nothing, a link, or something else). */
export function openDir(file: string, platform: NodeJS.Platform): Dir | undefined {
  if (!handles(platform)) return lstatIfAny(file)?.isDirectory() ? pathDir(file, () => true) : undefined;
  const fd = tryOpen(file, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  return fd === undefined ? undefined : handleDir(fd, file, () => true, () => lstatIfAny(file));
}

/** The folder or regular file `name` in `parent`, never through a link; undefined for anything else or nothing. */
export function openEntry(parent: Dir, name: string, platform: NodeJS.Platform): Entry | undefined {
  const at = path.join(parent.path, name);
  if (!handles(platform)) {
    const stat = parent.lstat(name);
    if (!stat || !(stat.isDirectory() || stat.isFile())) return undefined;
    const file = parent.at(name);
    return { stat, dir: stat.isDirectory() ? pathDir(file, () => parent.placed()) : undefined, chmod: mode => chmodSync(file, mode), close: () => undefined };
  }
  // O_NONBLOCK: a FIFO swapped in opens at once and is then skipped, it never blocks the start.
  const fd = tryOpen(parent.at(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY);
  if (fd === undefined) return undefined;
  const stat = fstatSync(fd);
  if (!stat.isDirectory() && !stat.isFile()) { closeSync(fd); return undefined; }
  return { stat, dir: stat.isDirectory() ? handleDir(fd, at, () => parent.placed(), () => parent.lstat(name)) : undefined, chmod: mode => fchmodSync(fd, mode), close: () => closeSync(fd) };
}

/** The real folder `name` in `parent`, or undefined. */
export function openChild(parent: Dir, name: string, platform: NodeJS.Platform): Dir | undefined {
  const entry = openEntry(parent, name, platform);
  if (entry && !entry.dir) entry.close();
  return entry?.dir;
}
