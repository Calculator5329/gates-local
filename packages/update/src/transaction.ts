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
import { isWindowsBootTime, type ProcessRecord } from "./identity.ts";
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
  /** The command changing the checkout. Still here later means it may still be at it: nothing may start until it has ended. */
  readonly running?: ProcessRecord;
}

export type Transaction =
  | (Common & { readonly phase: "forward" })
  | (Common & { readonly phase: "launch"; readonly startupToken?: string })
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

/** Atomic and on disk before it returns. */
function save(file: string, value: object): void {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, `${JSON.stringify({ version: 1, ...value }, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  flushDir(path.dirname(file));
}

/** Throws when it cannot be saved: nothing may move without it. */
export function saveTransaction(root: string, t: Transaction): void {
  const file = fileOf(root);
  if (file !== null) save(file, t);
}

/** The saved update is done with, and so is whatever a run said about it (`saveLeft`). */
export function clearTransaction(root: string): void {
  const file = fileOf(root);
  if (file === null) return;
  rmSync(file, { force: true });
  rmSync(path.join(path.dirname(file), LEFT_FILE), { force: true });
  flushDir(path.dirname(file));
}

export const LEFT_FILE = "gates-local-update-left.json";

/**
 * What a run that was asked to finish the saved update, and could not, said
 * is in the way: the lines it printed, for the start that asked (checkout-start.ts).
 * `to` is the commit of the update they are about; they mean nothing for another.
 */
export interface Left {
  readonly to: string;
  readonly lines: readonly string[];
}

export function saveLeft(root: string, left: Left): void {
  const dir = stateDir(root);
  if (dir !== null) save(path.join(dir, LEFT_FILE), left);
}

export function clearLeft(root: string): void {
  const dir = stateDir(root);
  if (dir !== null) rmSync(path.join(dir, LEFT_FILE), { force: true });
}

/** Null when there are none, or the file cannot be read as lines: the start then says only that the update did not finish. */
export function readLeft(root: string): Left | null {
  const dir = stateDir(root);
  if (dir === null) return null;
  try {
    const v = JSON.parse(readFileSync(path.join(dir, LEFT_FILE), "utf8")) as Record<string, unknown>;
    const { version, to, lines } = v;
    if (version !== 1 || !isString(to) || !Array.isArray(lines) || lines.length === 0 || !lines.every((l) => typeof l === "string")) return null;
    return { to, lines: lines as string[] };
  } catch {
    // No file, or not ours to read: there is nothing to add to the plain words.
    return null;
  }
}

const STEPS: ReadonlySet<string> = new Set(["switch", "install", "build-web", "build-desktop", "start"]);
const isString = (v: unknown): v is string => typeof v === "string" && v !== "";
const isCommit = (v: unknown): v is Commit => typeof v === "object" && v !== null && isString((v as Commit).commit) && isString((v as Commit).label);

function processOf(v: unknown): ProcessRecord | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const row = v as Record<string, unknown>;
  const { pid, start, uptime, boot } = row;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || !(start === null || isString(start)) || typeof uptime !== "number") return undefined;
  return { pid, start, uptime, ...(isWindowsBootTime(boot) ? { boot } : {}) };
}

function parse(text: string): Transaction | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const { version, channel, branch, from, to, changes, phase, step, reason, running } = v;
  if (version !== 1 || (channel !== "main" && channel !== "release") || !isString(branch) || !isCommit(from) || !isCommit(to)) return null;
  if (typeof changes !== "number" || !Number.isInteger(changes) || changes < 0) return null;
  const process = running === undefined ? undefined : processOf(running);
  if (running !== undefined && process === undefined) return null;
  const common: Common = { channel, branch, from, to, changes, ...(process === undefined ? {} : { running: process }) };
  if (phase === "forward") return { ...common, phase };
  if (phase === "launch" && (v["startupToken"] === undefined || isString(v["startupToken"]))) return { ...common, phase, ...(v["startupToken"] === undefined ? {} : { startupToken: v["startupToken"] }) };
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
