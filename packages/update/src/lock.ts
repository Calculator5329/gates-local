import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { guardTarget } from "./guard.ts";
import { startOf } from "./identity.ts";
import { isAlive } from "./wait.ts";

export const LOCK_FILE = "gates-local-update.lock";
const BEING_WRITTEN_MS = 60_000;
// why: more crashes in a row, each inside a takeover, than can really happen.
const MAX_RUNGS = 32;

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
  stillOurs(): boolean;
  release(): void;
}

export type Acquired = { readonly ok: true; readonly lock: UpdateLock } | { readonly ok: false; readonly pid: number | null; readonly file: string };

export interface LockOptions {
  readonly pid?: number;
  readonly alive?: (pid: number) => boolean;
  readonly startOf?: (pid: number) => string | null;
  readonly now?: () => number;
  readonly pauseAt?: (at: "judged" | "taking-over") => void;
}

interface Seen {
  readonly raw: string;
  readonly pid: number | null;
  readonly start: string | null;
  readonly touchedAt: number;
}

function parseOwner(raw: string): { pid: number | null; start: string | null } {
  try {
    const { pid, start } = JSON.parse(raw) as { pid?: unknown; start?: unknown };
    return { pid: typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null, start: typeof start === "string" ? start : null };
  } catch {
    return { pid: null, start: null };
  }
}

function read(file: string): Seen | null {
  try {
    const raw = readFileSync(file, "utf8");
    return { raw, ...parseOwner(raw), touchedAt: statSync(file).mtimeMs };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function ended(s: Seen, o: LockOptions): boolean {
  if (s.pid === null) return (o.now ?? Date.now)() - s.touchedAt > BEING_WRITTEN_MS;
  if (!(o.alive ?? isAlive)(s.pid)) return true;
  if (s.start === null) return false;
  const now = (o.startOf ?? startOf)(s.pid);
  return now !== null && now !== s.start;
}

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

function replace(file: string, text: string): boolean {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(tmp, "wx");
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    return true;
  } catch {
    rmSync(tmp, { force: true });
    return false;
  }
}

function clearClaims(file: string, prefix: string): void {
  const dir = path.dirname(file);
  for (const name of readdirSync(dir)) {
    if (name.startsWith(prefix)) rmSync(path.join(dir, name), { force: true });
  }
}

function claim(file: string, prefix: string, holder: string, o: LockOptions): string | "busy" | "gone" {
  for (let rung = 0; rung < MAX_RUNGS; rung++) {
    const candidate = path.join(path.dirname(file), `${prefix}${rung}`);
    if (create(candidate, holder)) return candidate;
    const other = read(candidate);
    if (other === null) return "gone";
    if (!ended(other, o)) return "busy";
  }
  return "busy";
}

function takeOver(file: string, judged: string, text: string, holder: string, o: LockOptions): "taken" | "busy" | "changed" {
  const prefix = `${path.basename(file)}.takeover.${createHash("sha256").update(judged).digest("hex").slice(0, 16)}.`;
  const claimed = claim(file, prefix, holder, o);
  if (claimed === "busy") return "busy";
  if (claimed === "gone") return "changed";
  o.pauseAt?.("taking-over");
  try {
    if (read(file)?.raw !== judged) return "changed";
    return replace(file, text) ? "taken" : "busy";
  } finally {
    // why: every rung names a lock that is gone or one this run failed to replace; none is relied on.
    clearClaims(file, prefix);
  }
}

function held(file: string, text: string): UpdateLock {
  const stillOurs = () => {
    try {
      return readFileSync(file, "utf8") === text;
    } catch {
      return false;
    }
  };
  return {
    stillOurs,
    release: () => {
      if (stillOurs()) rmSync(file, { force: true });
    },
  };
}

const NOT_A_CHECKOUT: UpdateLock = { stillOurs: () => true, release: () => undefined };

/** Takes the checkout's lock, replacing one whose owner has ended; never waits. */
export function acquireLock(root: string, o: LockOptions = {}): Acquired {
  const dir = stateDir(root);
  if (dir === null) return { ok: true, lock: NOT_A_CHECKOUT };
  const file = path.join(dir, LOCK_FILE);
  return acquireFileLock(file, o);
}

/** Exclusive recoverable lease at an owner-controlled path, also used by the phone socket. */
export function acquireFileLock(file: string, o: LockOptions = {}): Acquired {
  const pid = o.pid ?? process.pid;
  const start = (o.startOf ?? startOf)(pid);
  const text = JSON.stringify({ pid, start, startedAt: (o.now ?? Date.now)(), token: randomUUID() });
  // why: a few passes cover an owner that releases the lock between our create and our read.
  for (let pass = 0; pass < 3; pass++) {
    if (create(file, text)) return { ok: true, lock: held(file, text) };
    const seen = read(file);
    if (seen === null) continue;
    if (!ended(seen, o)) return { ok: false, pid: seen.pid, file };
    o.pauseAt?.("judged");
    const result = takeOver(file, seen.raw, text, JSON.stringify({ pid, start }), o);
    if (result === "taken") return { ok: true, lock: held(file, text) };
    if (result === "busy") return { ok: false, pid: null, file };
  }
  return { ok: false, pid: null, file };
}

/** Who is updating this checkout right now, without taking anything; null when nobody is. */
export function lockHolder(root: string, o: LockOptions = {}): { readonly pid: number | null; readonly file: string } | null {
  const dir = stateDir(root);
  if (dir === null) return null;
  const file = path.join(dir, LOCK_FILE);
  const seen = read(file);
  return seen === null || ended(seen, o) ? null : { pid: seen.pid, file };
}
