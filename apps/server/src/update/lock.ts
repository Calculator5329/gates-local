// One update of a checkout at a time, from before the first look at the
// checkout until after the last rollback step.
//
// The lock is a file in the checkout's own git folder, so it follows the
// checkout rather than the data folder, and it never shows in `git status`.
// Node built-ins only: it has to work while node_modules is being replaced.
//
// A crash leaves the file behind, so its owner can go stale:
// - the owner's pid is gone, or
// - the owner has not touched the file for STALE_MS (the pid was reused).
// The owner touches it every HEARTBEAT_MS. A stale file is renamed away, which
// only one taker can do, and the taker then checks that what it moved is what
// it judged stale. A lost lock is noticed too: a run stops before its next
// change when the file no longer holds its own token (it was paused past the
// limit, and someone took over).
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeSync } from "node:fs";
import path from "node:path";
import { guardTarget } from "./guard.ts";
import { isAlive } from "./wait.ts";

export const LOCK_FILE = "gates-local-update.lock";
export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 10 * 60_000;
/** A file with no owner written in it yet is someone between creating and writing it. */
const BEING_WRITTEN_MS = 60_000;

/**
 * The checkout's git folder: .git, or where a .git file points (a linked
 * worktree has its own). Null when this is not a checkout; inspect says so.
 * The updater's two files live here, so this passes the test guard first.
 */
export function stateDir(root: string): string | null {
  guardTarget(root);
  const dotGit = path.join(root, ".git");
  let dir: string;
  try {
    if (statSync(dotGit).isDirectory()) dir = dotGit;
    else {
      const named = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
      if (named === undefined) return null;
      dir = path.resolve(root, named);
    }
  } catch {
    return null;
  }
  guardTarget(dir);
  return dir;
}

export interface UpdateLock {
  /** False once the file no longer holds this run's token. */
  stillOurs(): boolean;
  release(): void;
}

export type Acquired = { readonly ok: true; readonly lock: UpdateLock } | { readonly ok: false; readonly pid: number | null };

export interface LockOptions {
  readonly pid?: number;
  readonly alive?: (pid: number) => boolean;
  readonly now?: () => number;
}

interface Seen {
  readonly raw: string;
  readonly pid: number | null;
  readonly touchedAt: number;
}

function ownerPid(raw: string): number | null {
  try {
    const pid = (JSON.parse(raw) as { pid?: unknown }).pid;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** The lock as it is now; null when there is none. */
function read(file: string): Seen | null {
  try {
    const raw = readFileSync(file, "utf8");
    return { raw, pid: ownerPid(raw), touchedAt: statSync(file).mtimeMs };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function isStale(s: Seen, o: LockOptions): boolean {
  const age = (o.now ?? Date.now)() - s.touchedAt;
  if (s.pid === null) return age > BEING_WRITTEN_MS;
  return !(o.alive ?? isAlive)(s.pid) || age > STALE_MS;
}

/** Creates the file only if there is none; false when there is one. */
function create(file: string, text: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(file, { force: true });
    throw e;
  }
  closeSync(fd);
  return true;
}

/**
 * Removes a lock judged stale. Between that judgment and this rename another
 * taker may have replaced it with a live one, so the moved file is compared
 * with what was judged. A live lock taken by mistake goes back; if something
 * newer is already there, its owner carries on and the mistaken one notices.
 */
export function takeAway(file: string, judged: string): boolean {
  const aside = `${file}.${process.pid}.${randomUUID()}`;
  try {
    renameSync(file, aside);
  } catch {
    return false;
  }
  const moved = readFileSync(aside, "utf8");
  if (moved === judged) {
    rmSync(aside, { force: true });
    return true;
  }
  try {
    linkSync(aside, file);
  } catch {
    // Something newer holds it now.
  }
  rmSync(aside, { force: true });
  return false;
}

function held(file: string, text: string): UpdateLock {
  const stillOurs = () => {
    try {
      return readFileSync(file, "utf8") === text;
    } catch {
      return false;
    }
  };
  const heartbeat = setInterval(() => {
    if (!stillOurs()) return;
    try {
      const at = new Date();
      utimesSync(file, at, at);
    } catch {
      // A missed beat costs nothing until STALE_MS of them are missed.
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  return {
    stillOurs,
    release: () => {
      clearInterval(heartbeat);
      if (stillOurs()) rmSync(file, { force: true });
    },
  };
}

const NOT_A_CHECKOUT: UpdateLock = { stillOurs: () => true, release: () => undefined };

/** Takes the checkout's lock, clearing a stale one; never waits. */
export function acquireLock(root: string, o: LockOptions = {}): Acquired {
  const dir = stateDir(root);
  if (dir === null) return { ok: true, lock: NOT_A_CHECKOUT };
  const file = path.join(dir, LOCK_FILE);
  const text = JSON.stringify({ pid: o.pid ?? process.pid, startedAt: (o.now ?? Date.now)(), token: randomUUID() });
  // Each pass either takes it, finds an owner or clears a dead one; a few passes cover a release in between.
  for (let pass = 0; pass < 3; pass++) {
    if (create(file, text)) return { ok: true, lock: held(file, text) };
    const seen = read(file);
    if (seen === null) continue;
    if (!isStale(seen, o)) return { ok: false, pid: seen.pid };
    if (!takeAway(file, seen.raw)) return { ok: false, pid: null };
  }
  return { ok: false, pid: null };
}

/** Who is updating this checkout right now, without taking anything; null when nobody is. */
export function lockHolder(root: string, o: LockOptions = {}): { readonly pid: number | null } | null {
  const dir = stateDir(root);
  if (dir === null) return null;
  const seen = read(path.join(dir, LOCK_FILE));
  return seen === null || isStale(seen, o) ? null : { pid: seen.pid };
}
