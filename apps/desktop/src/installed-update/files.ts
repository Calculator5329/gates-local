// The file operations an installed update performs, in one place, so a test
// can make any one of them return an error (a full disk, a refused link, a
// rename that takes effect and still reports failure) without a real fault.
//
// "Flush" in the design means fsync of the file, then fsync of the folder
// that holds it. Linux only: a folder that cannot be flushed is an error the
// caller handles, never swallowed (the clone updater swallows it for Windows).
import { createHash } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import type { ReleaseArtifact } from "../../../server/src/update/release-manifest.ts";

export interface FileOps {
  /** Creates or truncates `file`, writes `data`, fsyncs it and closes it. */
  writeFile(file: string, data: string, mode: number): void;
  rename(from: string, to: string): void;
  link(existing: string, created: string): void;
  copyFile(from: string, to: string): void;
  unlink(file: string): void;
  /** A folder and everything in it. */
  removeTree(dir: string): void;
  mkdir(dir: string, mode: number): void;
  chmod(file: string, mode: number): void;
  fsyncFile(file: string): void;
  fsyncDir(dir: string): void;
}

function fsyncPath(target: string): void {
  const fd = openSync(target, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export const realFileOps: FileOps = {
  writeFile(file, data, mode) {
    const fd = openSync(file, "w", mode);
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  rename: renameSync,
  link: linkSync,
  copyFile: (from, to) => copyFileSync(from, to),
  unlink: unlinkSync,
  removeTree: dir => rmSync(dir, { recursive: true, force: true }),
  mkdir: (dir, mode) => { mkdirSync(dir, { recursive: true, mode }); },
  chmod: chmodSync,
  fsyncFile: fsyncPath,
  fsyncDir: fsyncPath,
};

/** The system's error code (ENOSPC, EACCES, ...) of a returned I/O error, or null for anything else, which is not handled here. */
export function ioCode(error: unknown): string | null {
  if (!(error instanceof Error) || !("code" in error)) return null;
  const code = error.code;
  return typeof code === "string" && /^E[A-Z0-9]+$/.test(code) ? code : null;
}

/** The path a returned I/O error names, when it names one. */
export function ioPath(error: unknown): string | null {
  return error instanceof Error && "path" in error && typeof error.path === "string" ? error.path : null;
}

/** The destination a returned rename, link or copy error names: Node puts the source in `path` and the target in `dest`. */
export function ioDest(error: unknown): string | null {
  return error instanceof Error && "dest" in error && typeof error.dest === "string" ? error.dest : null;
}

export const isFullDisk = (code: string): boolean => code === "ENOSPC" || code === "EDQUOT";

export function exists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (e) {
    if (ioCode(e) === "ENOENT") return false;
    throw e;
  }
}

/** Removes `file` if it is there; true when something was removed. */
export function removeIfPresent(file: string, ops: FileOps): boolean {
  if (!exists(file)) return false;
  ops.unlink(file);
  return true;
}

/** The identity the release list pins: size and SHA-512 (lowercase hex) of the bytes. */
export type Identity = Pick<ReleaseArtifact, "size" | "sha512">;

const CHUNK = 1 << 20;

/**
 * The identity of the regular file at `file` now (a link is followed), or
 * null when nothing is there or what is there is not a regular file. A
 * folder or a named pipe is never opened: the first cannot be read and the
 * second would block the open.
 */
export function identify(file: string): Identity | null {
  let fd: number;
  try {
    if (!statSync(file).isFile()) return null;
    fd = openSync(file, "r");
  } catch (e) {
    if (ioCode(e) === "ENOENT") return null;
    throw e;
  }
  try {
    const hash = createHash("sha512");
    const buffer = Buffer.alloc(CHUNK);
    let size = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, CHUNK, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      size += read;
    }
    return { size, sha512: hash.digest("hex") };
  } finally {
    closeSync(fd);
  }
}

export const sameIdentity = (a: Identity | null, b: Identity): boolean => a !== null && a.size === b.size && a.sha512 === b.sha512;

/**
 * A saved file against the identity it should have: `same`, `missing`
 * (nothing there, a link to nothing, or a link loop), or `other` (other
 * bytes, or not a regular file). Anything that is not a regular file is
 * never opened: a folder cannot be read and a named pipe would block the open.
 */
export function savedFile(file: string, identity: Identity): "same" | "missing" | "other" {
  try {
    if (!statSync(file).isFile()) return "other";
  } catch (e) {
    const code = ioCode(e);
    if (code === "ENOENT" || code === "ELOOP") return "missing";
    throw e;
  }
  const found = identify(file);
  if (found === null) return "missing";
  return sameIdentity(found, identity) ? "same" : "other";
}

/** Renames `from` into `dir`, keeping its name unless something is already there. */
export function moveInto(from: string, dir: string, ops: FileOps): string {
  const name = path.basename(from);
  let target = path.join(dir, name);
  for (let n = 1; exists(target); n++) target = path.join(dir, `${name}.${n}`);
  ops.rename(from, target);
  return target;
}
