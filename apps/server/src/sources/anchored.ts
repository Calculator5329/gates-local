import { chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, openSync, readdirSync, unlinkSync, type Stats } from "node:fs";
import path from "node:path";

export interface Dir {
  readonly path: string;
  at(name: string): string;
  names(): string[];
  lstat(name: string): Stats | undefined;
  placed(): boolean;
  chmod(mode: number): void;
  close(): void;
}
export interface Entry {
  readonly stat: Stats;
  readonly dir?: Dir;
  chmod(mode: number): void;
  close(): void;
}

export function lstatIfAny(file: string): Stats | undefined {
  try { return lstatSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
}
export function sameFile(a: Stats | undefined, b: Stats | undefined): boolean {
  return a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino;
}
export function unlinkIfAny(dir: Dir, name: string): void {
  try { unlinkSync(dir.at(name)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
}

const handles = (platform: NodeJS.Platform) => platform === "linux" && existsSync("/proc/self/fd");
// why: a file this user cannot read (EACCES) is private already, so it is skipped
const SKIPPED = new Set(["ENOENT", "ELOOP", "ENOTDIR", "ENXIO", "EACCES"]);
const tryOpen = (file: string, flags: number) => {
  try { return openSync(file, flags); } catch (e) { if (SKIPPED.has((e as NodeJS.ErrnoException).code ?? "")) return undefined; throw e; }
};

// external: Linux resolves /proc/self/fd/<n>/<name> inside the held folder, wherever it is now
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
// why: without /proc only lstat guards a name, so a link swapped in after the check is followed
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

export function openDir(file: string, platform: NodeJS.Platform): Dir | undefined {
  if (!handles(platform)) return lstatIfAny(file)?.isDirectory() ? pathDir(file, () => true) : undefined;
  const fd = tryOpen(file, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  return fd === undefined ? undefined : handleDir(fd, file, () => true, () => lstatIfAny(file));
}

export function openEntry(parent: Dir, name: string, platform: NodeJS.Platform): Entry | undefined {
  const at = path.join(parent.path, name);
  if (!handles(platform)) {
    const stat = parent.lstat(name);
    if (!stat || !(stat.isDirectory() || stat.isFile())) return undefined;
    const file = parent.at(name);
    return { stat, dir: stat.isDirectory() ? pathDir(file, () => parent.placed()) : undefined, chmod: mode => chmodSync(file, mode), close: () => undefined };
  }
  // external: on Linux a FIFO opened without O_NONBLOCK waits for a writer and would block the start
  const fd = tryOpen(parent.at(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY);
  if (fd === undefined) return undefined;
  const stat = fstatSync(fd);
  if (!stat.isDirectory() && !stat.isFile()) { closeSync(fd); return undefined; }
  return { stat, dir: stat.isDirectory() ? handleDir(fd, at, () => parent.placed(), () => parent.lstat(name)) : undefined, chmod: mode => fchmodSync(fd, mode), close: () => closeSync(fd) };
}

export function openChild(parent: Dir, name: string, platform: NodeJS.Platform): Dir | undefined {
  const entry = openEntry(parent, name, platform);
  if (entry && !entry.dir) entry.close();
  return entry?.dir;
}
