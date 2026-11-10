// Rows B2a and B2b: putting the thread store back as it was when the person
// clicked Restart, from the copy the store made of itself before migrating.
//
// The copy is `<data dir>/store-copies/threads.v<N>.sqlite`, one file with no
// WAL, written by the store at migration time (threads/copies.ts, another
// lane). The live store is `threads.sqlite` with its `-wal` and `-shm`.
//
// B2a moves every live file into `store-copies/aside-<id>/`; B2b copies the
// copy to `threads.sqlite.restoring`, flushes it and renames it into place.
// Each function here is both the row's action and its recovery: run again
// after a crash, it finishes from whatever is on disk.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { exists, identify, moveInto, removeIfPresent, sameIdentity, type FileOps } from "./files.ts";

export const STORE_NAME = "threads.sqlite";
export const STORE_COPIES = "store-copies";
const SIDECARS = [`${STORE_NAME}-wal`, `${STORE_NAME}-shm`] as const;
/** B2a moves these, in this order; the stop points after each rename are named after them. */
export const STORE_FILES = [STORE_NAME, ...SIDECARS] as const;
export type StoreFile = (typeof STORE_FILES)[number];

export const copyPath = (dataDir: string, version: number): string => path.join(dataDir, STORE_COPIES, `threads.v${version}.sqlite`);
export const asideFolder = (dataDir: string, id: string): string => path.join(dataDir, STORE_COPIES, `aside-${id}`);
export const restoringPath = (dataDir: string): string => path.join(dataDir, `${STORE_NAME}.restoring`);

/** user_version of the SQLite file at `file`, opened read-only so nothing is created or checkpointed. Null when there is no file. */
export function storeVersion(file: string): number | null {
  if (!exists(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const value = db.prepare("PRAGMA user_version").get()?.["user_version"];
    if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${file} has no readable user_version`);
    return value;
  } finally {
    db.close();
  }
}

export type RestoreEntry =
  | { readonly kind: "not-needed" }
  | { readonly kind: "restore"; readonly copy: string }
  | { readonly kind: "copy-missing"; readonly copy: string }
  /** The copy does not open, or holds another version (`holds`, null when it does not open). */
  | { readonly kind: "copy-wrong"; readonly copy: string; readonly holds: number | null };

/**
 * B2a's entry condition: the live store's user_version is above `storeBefore`,
 * and the copy at `storeBefore` opens and holds `storeBefore`. Moves nothing.
 */
export function restoreEntry(dataDir: string, storeBefore: number): RestoreEntry {
  const live = storeVersion(path.join(dataDir, STORE_NAME));
  if (live === null || live <= storeBefore) return { kind: "not-needed" };
  const copy = copyPath(dataDir, storeBefore);
  if (!exists(copy)) return { kind: "copy-missing", copy };
  let holds: number | null;
  try {
    holds = storeVersion(copy);
  } catch {
    holds = null;
  }
  return holds === storeBefore ? { kind: "restore", copy } : { kind: "copy-wrong", copy, holds };
}

/**
 * Moves whichever of `names` are at the live path into the aside folder, then
 * flushes the aside folder and the data folder. The flushes run even when
 * nothing was left to move: after a kill that followed the last rename, they
 * are what makes the earlier renames durable.
 */
function moveLiveAside(dataDir: string, id: string, names: readonly StoreFile[], ops: FileOps, afterRename?: (name: StoreFile) => void): void {
  const aside = asideFolder(dataDir, id);
  const present = names.filter(name => exists(path.join(dataDir, name)));
  if (!exists(aside)) {
    ops.mkdir(aside, 0o700);
    ops.fsyncDir(path.dirname(aside));
  }
  for (const name of present) {
    moveInto(path.join(dataDir, name), aside, ops);
    afterRename?.(name);
  }
  ops.fsyncDir(aside);
  ops.fsyncDir(dataDir);
}

/**
 * B2a, action and recovery alike: move whatever of the store is still at the
 * live path aside, then flush both folders. Nothing can create a live file in
 * this phase (T1 is stopped, T2 does not exist), so running it again is safe.
 */
export function setAside(dataDir: string, id: string, ops: FileOps, afterRename?: (name: StoreFile) => void): void {
  moveLiveAside(dataDir, id, STORE_FILES, ops, afterRename);
}

/**
 * B2b, action and recovery alike: copy, flush, rename into place, flush the folder.
 *
 * Two guards beyond the design's text, both from its rule that recovery never
 * trusts the phase alone (see the lane report):
 * - A `-wal` or `-shm` at the live path in this phase can only be the old
 *   store's whose aside rename did not last. SQLite would replay that WAL onto
 *   the restored copy, so it joins the others in the aside folder first.
 * - A `threads.sqlite` at the live path counts as this phase's rename only when
 *   its bytes are the copy's. Anything else is the old store, and is set aside.
 */
export function installCopy(dataDir: string, id: string, storeBefore: number, ops: FileOps, at?: (point: "flush" | "rename") => void): void {
  const live = path.join(dataDir, STORE_NAME);
  const copy = copyPath(dataDir, storeBefore);
  moveLiveAside(dataDir, id, SIDECARS, ops);
  if (exists(live)) {
    const expected = identify(copy);
    if (expected !== null && sameIdentity(identify(live), expected)) {
      ops.fsyncDir(dataDir);
      return;
    }
    moveLiveAside(dataDir, id, [STORE_NAME], ops);
  }
  const restoring = restoringPath(dataDir);
  removeIfPresent(restoring, ops);
  ops.copyFile(copy, restoring);
  ops.fsyncFile(restoring);
  at?.("flush");
  ops.rename(restoring, live);
  at?.("rename");
  ops.fsyncDir(dataDir);
}
