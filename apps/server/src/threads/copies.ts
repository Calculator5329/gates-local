import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { StoreCopyError } from "./errors.ts";

function syncFolder(folder: string): void {
  // external: Windows cannot flush a folder handle; the rename there is still atomic
  if (process.platform === "win32") return;
  const fd = fs.openSync(folder, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// external: on Windows a scanner or a second app holding either file open refuses a rename briefly
function renameIntoPlace(from: string, to: string): void {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0, step = 10; ; waited += step, step = Math.min(step * 2, 200)) {
    try { fs.renameSync(from, to); return; }
    catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      const passing = process.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "EBUSY");
      if (!passing || waited >= 2_000) throw error;
      // why: opening a store is synchronous, so the wait is too
      Atomics.wait(pause, 0, 0, step);
    }
  }
}

export function copyBeforeMigration(db: DatabaseSync, dbPath: string, latest: number): void {
  let temporary: string | undefined;
  let action = "the chat database could not be checked";
  try {
    const location = db.location();
    if (!location) return;
    // external: SQLite resolves folder links, so file identity is compared, not path text
    action = "the chat database file is not where it was opened";
    const file = fs.statSync(dbPath);
    const source = fs.statSync(location);
    if (!file.isFile() || !source.isFile() || source.dev !== file.dev || source.ino !== file.ino) throw new Error("store path mismatch");

    const parent = dirname(dbPath);
    const folder = join(parent, "store-copies");
    action = "the folder for the copy could not be created";
    const created = fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    fs.chmodSync(folder, 0o700);
    // why: a crash could lose a new folder's entry in its parent, and the copy with it
    if (created !== undefined) syncFolder(parent);

    action = "the temporary copy could not be created";
    const candidate = join(folder, `.copy-${randomUUID()}.sqlite`);
    const fd = fs.openSync(candidate, "wx", 0o600);
    temporary = candidate;
    fs.closeSync(fd);
    action = "the chat database could not be copied";
    // external: SQLite's VACUUM INTO writes into an existing empty file, so it is made 0600 first
    db.exec(`VACUUM INTO '${temporary.replaceAll("'", "''")}'`);

    action = "the saved copy could not be opened or read";
    const copy = new DatabaseSync(temporary, { readOnly: true });
    let version: unknown;
    try { version = copy.prepare("PRAGMA user_version").get()?.["user_version"]; }
    finally { copy.close(); }
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) throw new Error("invalid copy version");
    if (version === latest) {
      const unneeded = temporary;
      temporary = undefined;
      try { fs.unlinkSync(unneeded); } catch {}
      return;
    }

    action = "the saved copy could not be saved to disk";
    // external: Windows flushes a file only through a handle that may write
    const copyFd = fs.openSync(temporary, "r+");
    try { fs.fsyncSync(copyFd); } finally { fs.closeSync(copyFd); }
    action = "the saved copy could not be put in its final place";
    renameIntoPlace(temporary, join(folder, `threads.v${version}.sqlite`));
    temporary = undefined;
    action = "the folder holding the copy could not be saved to disk";
    syncFolder(folder);
  } catch (cause) {
    if (temporary !== undefined) {
      try { fs.unlinkSync(temporary); } catch {}
    }
    throw new StoreCopyError(dbPath, cause, action);
  }
}
