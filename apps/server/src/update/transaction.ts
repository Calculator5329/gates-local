// What an update has promised to finish, kept where a crash cannot lose it.
//
// Written before the checkout moves and removed only once the update has
// finished, or has gone all the way back. A file left behind means the last
// run was cut off (or its rollback failed), so "this copy has the newest
// commit" proves nothing: the install and builds may never have happened.
//
// In the checkout's git folder, next to the lock. Node built-ins only, like
// the lock, so shapes are checked by hand here.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import type { Step } from "./apply.ts";
import type { Channel, Commit } from "./check.ts";
import { stateDir } from "./lock.ts";

export const TRANSACTION_FILE = "gates-local-update.json";

interface Common {
  readonly channel: Channel;
  /** The branch the update moved; a different one now means someone has moved on. */
  readonly branch: string;
  readonly from: Commit;
  readonly to: Commit;
  /** Commits between from and to. */
  readonly changes: number;
}

export type Transaction =
  | (Common & { readonly phase: "forward" })
  /** A step failed and the run started back to `from`. */
  | (Common & { readonly phase: "back"; readonly step: Step; readonly reason: string });

function fileOf(root: string): string | null {
  const dir = stateDir(root);
  return dir === null ? null : path.join(dir, TRANSACTION_FILE);
}

function flushDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    fsyncSync(fd);
    closeSync(fd);
  } catch {
    // Windows cannot open a folder this way; the rename is still atomic.
  }
}

/** Atomic and on disk before it returns. Throws when it cannot be saved: nothing may move without it. */
export function saveTransaction(root: string, t: Transaction): void {
  const file = fileOf(root);
  if (file === null) return;
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, `${JSON.stringify({ version: 1, ...t }, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  flushDir(path.dirname(file));
}

export function clearTransaction(root: string): void {
  const file = fileOf(root);
  if (file === null) return;
  rmSync(file, { force: true });
  flushDir(path.dirname(file));
}

const STEPS: ReadonlySet<string> = new Set(["switch", "install", "build-web", "build-desktop"]);
const isString = (v: unknown): v is string => typeof v === "string" && v !== "";
const isCommit = (v: unknown): v is Commit => typeof v === "object" && v !== null && isString((v as Commit).commit) && isString((v as Commit).label);

function parse(text: string): Transaction | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const { version, channel, branch, from, to, changes, phase, step, reason } = v;
  if (version !== 1 || (channel !== "main" && channel !== "release") || !isString(branch) || !isCommit(from) || !isCommit(to)) return null;
  if (typeof changes !== "number" || !Number.isInteger(changes) || changes < 0) return null;
  const common: Common = { channel, branch, from, to, changes };
  if (phase === "forward") return { ...common, phase };
  if (phase === "back" && isString(step) && STEPS.has(step) && typeof reason === "string") return { ...common, phase, step: step as Step, reason };
  return null;
}

/** The unfinished update, or null. A file that does not parse cannot be acted on and counts as none. */
export function readTransaction(root: string): Transaction | null {
  const file = fileOf(root);
  if (file === null) return null;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  return parse(text);
}
