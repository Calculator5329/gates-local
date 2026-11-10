// IR-01: rows B2a and B2b, resumed from every store state the design names
// (docs/design/installed-updates.md, section 2 table and section 10).
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { realFileOps } from "./files.ts";
import { asideFolder, copyPath, installCopy, restoreEntry, setAside, STORE_NAME } from "./restore.ts";
import { contents, copyStore, createStore, liveFiles, migrateWithLiveWal } from "./store-fixture.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const ID = "tx1";
const BEFORE = ["alpha", "beta"];
const MIGRATED = ["alpha", "beta", "gamma"];

/** A data folder whose store was at v4 with a copy, then migrated to v6 by a version that was stopped with its WAL live. */
function migrated(): { dataDir: string; live: string } {
  const root = mkdtempSync(path.join(tmpdir(), "iu-restore-")); roots.push(root);
  const dataDir = path.join(root, "data");
  createStore(dataDir, 4, BEFORE);
  copyStore(dataDir);
  migrateWithLiveWal(dataDir, 6, ["gamma"]);
  return { dataDir, live: path.join(dataDir, STORE_NAME) };
}

function expectRestored(dataDir: string): void {
  expect(contents(path.join(dataDir, STORE_NAME))).toEqual({ version: 4, ids: BEFORE });
  expect(existsSync(path.join(dataDir, `${STORE_NAME}.restoring`))).toBe(false);
}

/** The files version 6 left are kept whole in the aside folder: opening them gives its rows. */
function expectAsideWhole(dataDir: string): void {
  const aside = asideFolder(dataDir, ID);
  const scratch = mkdtempSync(path.join(path.dirname(dataDir), "iu-aside-"));
  for (const name of readdirSync(aside)) copyFileSync(path.join(aside, name), path.join(scratch, name));
  expect(contents(path.join(scratch, STORE_NAME))).toEqual({ version: 6, ids: MIGRATED });
}

describe("IR-01, the restore", () => {
  it("the fixture is what it claims: the migrated store's WAL is live and holds the migration", () => {
    const { dataDir, live } = migrated();
    expect(liveFiles(dataDir)).toEqual([STORE_NAME, `${STORE_NAME}-wal`, `${STORE_NAME}-shm`]);
    expect(contents(live)).toEqual({ version: 6, ids: MIGRATED });
    expect(contents(copyPath(dataDir, 4))).toEqual({ version: 4, ids: BEFORE });
  });

  it("entry: restores only when the store is above storeBefore and the copy opens and holds storeBefore", () => {
    const { dataDir } = migrated();
    expect(restoreEntry(dataDir, 4)).toEqual({ kind: "restore", copy: copyPath(dataDir, 4) });
    expect(restoreEntry(dataDir, 6)).toEqual({ kind: "not-needed" });
    expect(restoreEntry(dataDir, 7)).toEqual({ kind: "not-needed" });
    expect(restoreEntry(dataDir, 3)).toEqual({ kind: "copy-missing", copy: copyPath(dataDir, 3) });
  });

  it("B2a run again after a kill that followed its last rename still flushes both folders before it counts as done", () => {
    const { dataDir } = migrated();
    expect(() => setAside(dataDir, ID, realFileOps, name => { if (name === `${STORE_NAME}-shm`) throw new Error("killed"); })).toThrow("killed");
    expect(liveFiles(dataDir)).toEqual([]);
    const flushed: string[] = [];
    setAside(dataDir, ID, { ...realFileOps, fsyncDir: dir => { flushed.push(dir); realFileOps.fsyncDir(dir); } });
    expect(flushed.toSorted()).toEqual([asideFolder(dataDir, ID), dataDir].toSorted());
  });

  it("B2a then B2b from a database set aside while its WAL is still live", () => {
    const { dataDir } = migrated();
    setAside(dataDir, ID, realFileOps);
    expect(liveFiles(dataDir)).toEqual([]);
    installCopy(dataDir, ID, 4, realFileOps);
    expectRestored(dataDir);
    expectAsideWhole(dataDir);
  });

  for (const [crashAfter, left] of [[STORE_NAME, 2], [`${STORE_NAME}-wal`, 1], [`${STORE_NAME}-shm`, 0]] as const) {
    it(`B2a resumed after the rename of ${crashAfter}: moves whatever is still live, then B2b`, () => {
      const { dataDir } = migrated();
      expect(() => setAside(dataDir, ID, realFileOps, name => { if (name === crashAfter) throw new Error("crash"); })).toThrow("crash");
      expect(liveFiles(dataDir)).toHaveLength(left);
      setAside(dataDir, ID, realFileOps);
      installCopy(dataDir, ID, 4, realFileOps);
      expectRestored(dataDir);
      expectAsideWhole(dataDir);
    });
  }

  it("a copy installed before the aside moves were durable: the old WAL left at the live path is never replayed onto the copy", () => {
    const { dataDir, live } = migrated();
    const aside = asideFolder(dataDir, ID);
    mkdirSync(aside, { recursive: true });
    // The B2b rename survived, the WAL and SHM renames did not.
    copyFileSync(live, path.join(aside, STORE_NAME));
    copyFileSync(copyPath(dataDir, 4), live);
    installCopy(dataDir, ID, 4, realFileOps);
    expectRestored(dataDir);
    expect(liveFiles(dataDir)).toEqual([STORE_NAME]);
    expectAsideWhole(dataDir);
  });

  it("a live store that is not the copy under restore-install (the aside rename was lost) is set aside, not kept", () => {
    const { dataDir } = migrated();
    installCopy(dataDir, ID, 4, realFileOps);
    expectRestored(dataDir);
    expectAsideWhole(dataDir);
  });

  it("B2b resumed with a partial .restoring, after its flush, and after its rename", () => {
    for (const point of ["partial", "flush", "rename"] as const) {
      const { dataDir } = migrated();
      setAside(dataDir, ID, realFileOps);
      if (point === "partial") writeFileSync(path.join(dataDir, `${STORE_NAME}.restoring`), "half a copy");
      else expect(() => installCopy(dataDir, ID, 4, realFileOps, at => { if (at === point) throw new Error("crash"); })).toThrow("crash");
      installCopy(dataDir, ID, 4, realFileOps);
      expectRestored(dataDir);
    }
  });

  it("a missing copy or a copy at the wrong version moves nothing", () => {
    const { dataDir, live } = migrated();
    rmSync(copyPath(dataDir, 4));
    expect(restoreEntry(dataDir, 4)).toEqual({ kind: "copy-missing", copy: copyPath(dataDir, 4) });
    // A copy named v4 that holds v5.
    createStore(path.join(dataDir, "elsewhere"), 5, BEFORE);
    copyFileSync(path.join(dataDir, "elsewhere", STORE_NAME), copyPath(dataDir, 4));
    expect(restoreEntry(dataDir, 4)).toEqual({ kind: "copy-wrong", copy: copyPath(dataDir, 4), holds: 5 });
    writeFileSync(copyPath(dataDir, 4), "not a database at all, just bytes that are long enough to look like a header".repeat(20));
    expect(restoreEntry(dataDir, 4)).toEqual({ kind: "copy-wrong", copy: copyPath(dataDir, 4), holds: null });
    expect(liveFiles(dataDir)).toEqual([STORE_NAME, `${STORE_NAME}-wal`, `${STORE_NAME}-shm`]);
    expect(contents(live)).toEqual({ version: 6, ids: MIGRATED });
  });

  it("intermediate copies present: the copy at storeBefore is the one restored", () => {
    const root = mkdtempSync(path.join(tmpdir(), "iu-restore-")); roots.push(root);
    const dataDir = path.join(root, "data");
    createStore(dataDir, 4, BEFORE);
    copyStore(dataDir);
    migrateWithLiveWal(dataDir, 5, ["half"]);
    copyStore(dataDir); // an interrupted migration's v5 copy
    migrateWithLiveWal(dataDir, 6, ["gamma"]);
    expect(restoreEntry(dataDir, 4)).toEqual({ kind: "restore", copy: copyPath(dataDir, 4) });
    setAside(dataDir, ID, realFileOps);
    installCopy(dataDir, ID, 4, realFileOps);
    expectRestored(dataDir);
    expect(contents(copyPath(dataDir, 5)).version).toBe(5);
  });
});
