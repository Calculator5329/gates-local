import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { StoreCopyError } from "./errors.ts";

function syncFolder(folder: string): void {
  // Windows cannot flush a folder handle; the rename there is still atomic.
  if (process.platform === "win32") return;
  const fd = fs.openSync(folder, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/**
 * Windows refuses a rename with EPERM, EACCES or EBUSY while another program
 * has either file open: a scanner, or a second Gates Local putting its own copy
 * at the same name. That passes in milliseconds, so try again for up to two
 * seconds before refusing the start. Elsewhere those codes mean a real
 * permission problem, and waiting would only delay saying so.
 */
function renameIntoPlace(from: string, to: string): void {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0, step = 10; ; waited += step, step = Math.min(step * 2, 200)) {
    try { fs.renameSync(from, to); return; }
    catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      const passing = process.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "EBUSY");
      if (!passing || waited >= 2_000) throw error;
      // Opening a store is synchronous, so the wait is too.
      Atomics.wait(pause, 0, 0, step);
    }
  }
}

/** Publish one self-contained pre-upgrade snapshot, including committed WAL rows. */
export function copyBeforeMigration(db: DatabaseSync, dbPath: string, latest: number): void {
  let temporary: string | undefined;
  let action = "the chat database could not be checked";
  try {
    // SQLite reports null for memory/temporary databases: nothing on disk to keep.
    const location = db.location();
    if (!location) return;
    // From here the store is a real file, so no step may run without a copy.
    // The copy goes beside dbPath; refuse if that is not the file SQLite has
    // open (moved or replaced since). SQLite resolves directory links, so
    // compare file identity, not path text.
    action = "the chat database file is not where it was opened";
    const file = fs.statSync(dbPath);
    const source = fs.statSync(location);
    if (!file.isFile() || !source.isFile() || source.dev !== file.dev || source.ino !== file.ino) throw new Error("store path mismatch");

    const parent = dirname(dbPath);
    const folder = join(parent, "store-copies");
    action = "the folder for the copy could not be created";
    const created = fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    fs.chmodSync(folder, 0o700);
    // Persist the new folder's entry in its parent as well as the final rename.
    if (created !== undefined) syncFolder(parent);

    action = "the temporary copy could not be created";
    const candidate = join(folder, `.copy-${randomUUID()}.sqlite`);
    const fd = fs.openSync(candidate, "wx", 0o600);
    temporary = candidate;
    fs.closeSync(fd);
    action = "the chat database could not be copied";
    // VACUUM INTO accepts an existing empty file. Reserve it first so private
    // permissions apply from its first byte, regardless of the process umask.
    db.exec(`VACUUM INTO '${temporary.replaceAll("'", "''")}'`);

    action = "the saved copy could not be opened or read";
    const copy = new DatabaseSync(temporary, { readOnly: true });
    let version: unknown;
    try { version = copy.prepare("PRAGMA user_version").get()?.["user_version"]; }
    finally { copy.close(); }
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) throw new Error("invalid copy version");
    // Another opener may have finished the migration before VACUUM's snapshot.
    // The store needs no copy then, so a temporary file that cannot be removed
    // (a scanner holding it open on Windows) must not stop the start.
    if (version === latest) {
      const unneeded = temporary;
      temporary = undefined;
      try { fs.unlinkSync(unneeded); } catch { /* left behind; never mistaken for a copy */ }
      return;
    }

    action = "the saved copy could not be saved to disk";
    // "r+": Windows only flushes through a handle that may write.
    const copyFd = fs.openSync(temporary, "r+");
    try { fs.fsyncSync(copyFd); } finally { fs.closeSync(copyFd); }
    action = "the saved copy could not be put in its final place";
    renameIntoPlace(temporary, join(folder, `threads.v${version}.sqlite`));
    temporary = undefined;
    action = "the folder holding the copy could not be saved to disk";
    syncFolder(folder);
  } catch (cause) {
    // Never prune copies or another call's temporary file. Crash leftovers are
    // deliberately retained; a later cleanup policy can handle them separately.
    // A temporary file that cannot be removed stays; the person is told the
    // first cause, not the cleanup's.
    if (temporary !== undefined) {
      try { fs.unlinkSync(temporary); } catch { /* left behind; never mistaken for a copy */ }
    }
    throw new StoreCopyError(dbPath, cause, action);
  }
}
