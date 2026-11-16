import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { copyPath, STORE_NAME } from "./restore.ts";

const SIDECARS = ["-wal", "-shm"] as const;
// why: these fixtures are never read after a power cut, so SQLite need not wait for the disk.
const NO_FLUSH = "PRAGMA synchronous = OFF";

export function createStore(dataDir: string, version: number, ids: readonly string[]): void {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, STORE_NAME));
  db.exec(`${NO_FLUSH}; PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY)`);
  const insert = db.prepare("INSERT INTO threads (id) VALUES (?)");
  for (const id of ids) insert.run(id);
  db.exec(`PRAGMA user_version = ${version}`);
  db.close();
}

export function copyStore(dataDir: string, named = currentVersion(path.join(dataDir, STORE_NAME))): string {
  const target = copyPath(dataDir, named);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  rmSync(target, { force: true });
  const db = new DatabaseSync(path.join(dataDir, STORE_NAME));
  db.exec(NO_FLUSH);
  db.prepare("VACUUM INTO ?").run(target);
  db.close();
  return target;
}

export function migrateWithLiveWal(dataDir: string, version: number, addIds: readonly string[]): void {
  const live = path.join(dataDir, STORE_NAME);
  const snapshot = mkdtempSync(path.join(path.dirname(dataDir), "iu-wal-"));
  const db = new DatabaseSync(live);
  db.exec(`${NO_FLUSH}; PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0`);
  const insert = db.prepare("INSERT INTO threads (id) VALUES (?)");
  for (const id of addIds) insert.run(id);
  db.exec(`PRAGMA user_version = ${version}`);
  // external: SQLite checkpoints and deletes the WAL on close, so the files are copied while open.
  for (const suffix of ["", ...SIDECARS]) copyFileSync(live + suffix, path.join(snapshot, STORE_NAME + suffix));
  db.close();
  for (const suffix of ["", ...SIDECARS]) copyFileSync(path.join(snapshot, STORE_NAME + suffix), live + suffix);
  rmSync(snapshot, { recursive: true, force: true });
}

export function currentVersion(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Number(db.prepare("PRAGMA user_version").get()?.["user_version"]);
  } finally {
    db.close();
  }
}

export function contents(file: string): { readonly version: number; readonly ids: readonly string[] } {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const version = Number(db.prepare("PRAGMA user_version").get()?.["user_version"]);
    const ids = db.prepare("SELECT id FROM threads ORDER BY id").all().map(row => String(row["id"]));
    return { version, ids };
  } finally {
    db.close();
  }
}

export const liveFiles = (dataDir: string): string[] => ["", ...SIDECARS].filter(s => existsSync(path.join(dataDir, STORE_NAME + s))).map(s => STORE_NAME + s);
