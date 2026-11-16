import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { brokenForTest } from "@gates-local/update/break-for-test";
import { exists, identify, moveInto, removeIfPresent, sameIdentity, type FileOps } from "@gates-local/update/installed/files";

export const STORE_NAME = "threads.sqlite";
export const STORE_COPIES = "store-copies";
const SIDECARS = [`${STORE_NAME}-wal`, `${STORE_NAME}-shm`] as const;
export const STORE_FILES = [STORE_NAME, ...SIDECARS] as const;
export type StoreFile = (typeof STORE_FILES)[number];

export const copyPath = (dataDir: string, version: number): string => path.join(dataDir, STORE_COPIES, `threads.v${version}.sqlite`);
export const asideFolder = (dataDir: string, id: string): string => path.join(dataDir, STORE_COPIES, `aside-${id}`);
export const restoringPath = (dataDir: string): string => path.join(dataDir, `${STORE_NAME}.restoring`);

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
  | { readonly kind: "copy-wrong"; readonly copy: string; readonly holds: number | null };

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

function moveLiveAside(dataDir: string, id: string, names: readonly StoreFile[], ops: FileOps, afterRename?: (name: StoreFile) => void): void {
  const aside = asideFolder(dataDir, id);
  const present = names.filter(name => exists(path.join(dataDir, name)));
  if (!exists(aside)) {
    ops.mkdir(aside, 0o700);
    ops.fsyncDir(path.dirname(aside));
  }
  for (const name of present) {
    if (brokenForTest("go-back-drops-the-store")) ops.unlink(path.join(dataDir, name));
    else moveInto(path.join(dataDir, name), aside, ops);
    afterRename?.(name);
  }
  ops.fsyncDir(aside);
  ops.fsyncDir(dataDir);
}

export function setAside(dataDir: string, id: string, ops: FileOps, afterRename?: (name: StoreFile) => void): void {
  moveLiveAside(dataDir, id, STORE_FILES, ops, afterRename);
}

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
