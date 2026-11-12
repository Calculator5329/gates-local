// The watcher's returned errors, a dead watcher, one mover, and the ending
// cases outside the crash matrix (watch-matrix.test.ts).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireFileLock } from "../../../server/src/update/lock.ts";
import { holds } from "./linux.ts";
import { contents, copyStore } from "./store-fixture.ts";
import { updateLockFile, type InstalledTransaction } from "./transaction.ts";
import { beginUpdate, resumeWatcher, retryCleanup, runWatcher, type WatcherEffects } from "./watch.ts";
import { attempt, BEFORE, checkInvariants, FROM, MIGRATED, newLog, removeWorlds, STORE_AFTER, STORE_BEFORE, TO, World, type Fault, type RunEnd, type RunLog } from "./watch-fixture.ts";
import * as words from "./words.ts";

afterEach(removeWorlds);

const disk = (dir: string) => words.disk(dir, TO, 1, 1_000_000);
const is =(file: string) => (args: readonly string[]) => args[args.length - 1] === file;
const from = (file: string) => (args: readonly string[]) => args[0] === file;

/** Row H and the watcher, with the faults given, checking the invariants. */
async function update(w: World, faults: Fault[] = []): Promise<{ end: RunEnd; log: RunLog }> {
  const log = newLog();
  const fx = w.effects(log);
  w.faults = faults;
  beginUpdate(w.approval, { spawnWatcher: () => undefined, fs: fx.fs, earlierFailure: false });
  const end = await attempt(() => runWatcher(w.file, fx));
  checkInvariants(w, end, log);
  w.faults = [];
  return { end, log };
}

async function resume(w: World): Promise<{ end: RunEnd; log: RunLog }> {
  const log = newLog();
  const end = await attempt(() => resumeWatcher(w.file, w.effects(log)));
  checkInvariants(w, end, log);
  return { end, log };
}

/**
 * A file the watcher did not put at the program path, put there as a new
 * file. Writing into the old one would change `.previous-<id>` too, which is
 * a hard link to it after S2.
 */
const putUnknownFile = (w: World) => {
  rmSync(w.program);
  writeFileSync(w.program, "someone else's file");
};

const stoppedBeforeReplace =(w: World, end: RunEnd, sentence: words.Words) => {
  expect(end).toEqual({ outcome: "stopped", words: sentence, cleaned: true, startApp: true });
  expect(holds(w.program, w.old, w.new)).toBe("old");
  expect([existsSync(w.paths.incoming), existsSync(w.paths.previousPart), existsSync(w.paths.previous)]).toEqual([false, false, false]);
  expect(contents(w.live)).toEqual({ version: STORE_BEFORE, ids: BEFORE });
  expect(w.transaction()).toBeNull();
  expect(w.results.get("tx1")).toMatchObject({ outcome: "stopped", words: sentence });
};

describe("returned errors before the replace end stopped, with the staging removed", () => {
  const noPermission = words.cannotReplace("no-permission", TO);

  it("W2: not enough free space", async () => {
    const w = new World(); w.free = 10;
    const { end } = await update(w);
    stoppedBeforeReplace(w, end, words.disk(path.dirname(w.program), TO, 1, 0));
  });

  it("W2: ENOSPC writing its intent", async () => {
    const w = new World();
    const { end } = await update(w, [{ op: "writeFile", match: is(`${w.file}.tmp`), code: "ENOSPC", times: 1, skip: 1 }]);
    stoppedBeforeReplace(w, end, disk(w.dataDir));
  });

  it.each(["EACCES", "EROFS"])("W2: %s writing its intent, outside the program folder: could not start the update, naming the file", async code => {
    const w = new World();
    const { end } = await update(w, [{ op: "writeFile", match: is(`${w.file}.tmp`), code, times: 1, skip: 1 }]);
    stoppedBeforeReplace(w, end, words.couldNotStartUpdate(`${w.file}.tmp`));
  });

  it("S1: ENOSPC copying the artifact, leaving a partial file", async () => {
    const w = new World();
    const { end } = await update(w, [{ op: "copyFile", match: is(w.paths.incoming), code: "ENOSPC", when: "after" }]);
    stoppedBeforeReplace(w, end, disk(path.dirname(w.program)));
  });

  it("S1: EACCES copying the artifact", async () => {
    const w = new World();
    const { end } = await update(w, [{ op: "copyFile", match: is(w.paths.incoming), code: "EACCES" }]);
    stoppedBeforeReplace(w, end, noPermission);
  });

  it("S2: EACCES on the hard link", async () => {
    const w = new World();
    const { end } = await update(w, [{ op: "link", match: is(w.paths.previous), code: "EACCES" }]);
    stoppedBeforeReplace(w, end, noPermission);
  });

  it("S2: links refused, then ENOSPC copying to .part", async () => {
    const w = new World();
    const { end } = await update(w, [{ op: "link", match: is(w.paths.previous), code: "EPERM" }, { op: "copyFile", match: is(w.paths.previousPart), code: "ENOSPC", when: "after" }]);
    stoppedBeforeReplace(w, end, disk(path.dirname(w.program)));
  });

  it("S3: a rename that returns EACCES and left old in place", async () => {
    const w = new World();
    const { end } = await update(w, [{ op: "rename", match: from(w.paths.incoming), code: "EACCES" }]);
    stoppedBeforeReplace(w, end, noPermission);
  });

  it("S3: a rename that returns EROFS and left old in place: the read-only sentence", async () => {
    const w = new World();
    const { end } = await update(w, [{ op: "rename", match: from(w.paths.incoming), code: "EROFS" }]);
    stoppedBeforeReplace(w, end, words.cannotReplace("read-only", TO));
  });

  it("S3: a rename that returns ENOSPC and left old in place", async () => {
    const w = new World();
    const { end } = await update(w, [{ op: "rename", match: from(w.paths.incoming), code: "ENOSPC" }]);
    stoppedBeforeReplace(w, end, disk(path.dirname(w.program)));
  });
});

describe("an S3 rename that returns an error after taking effect", () => {
  it("is not trusted: the path holds new, so the watcher flushes and carries on to L1", async () => {
    const w = new World();
    const { end, log } = await update(w, [{ op: "rename", match: from(w.paths.incoming), code: "EIO", when: "after" }]);
    expect(end).toEqual({ outcome: "updated", cleaned: true, startApp: false });
    expect(log.spawns).toHaveLength(1);
  });

  it("with the folder flush failing too: stuck, replace paused, every file kept, and a resume carries on at S3", async () => {
    const w = new World();
    const dir = path.dirname(w.program);
    const { end, log } = await update(w, [
      { op: "rename", match: from(w.paths.incoming), code: "EIO", when: "after" },
      // S1 and S2 flush the folder once each; the third is S3's.
      { op: "fsyncDir", match: is(dir), code: "ENOSPC", skip: 2 },
    ]);
    expect(end).toEqual({ outcome: "stuck", words: words.replacePaused({ kind: "disk" }), intent: "replace" });
    expect(log.pages).toEqual([words.replacePaused({ kind: "disk" })]);
    expect(log.spawns).toEqual([]);
    expect(w.transaction()?.intent).toBe("replace");
    expect([existsSync(w.paths.previous), existsSync(w.download)]).toEqual([true, true]);
    expect(holds(w.program, w.old, w.new)).toBe("new");
    const again = await resume(w);
    expect(again.end).toEqual({ outcome: "updated", cleaned: true, startApp: false });
    expect(again.log.ops.indexOf(`fsyncDir apps`)).toBeLessThan(again.log.ops.findIndex(op => op.startsWith("writeFile")));
  });
});

describe("returned errors while going back: stuck, go-back paused, every file kept, a resume finishes", () => {
  const cases: readonly [string, (w: World) => { fault: Fault; cause: words.PauseCause; intent: string; kept: string[] }][] = [
    ["B2a: EACCES moving the store aside", w => ({ fault: { op: "rename", match: from(w.live), code: "EACCES" }, cause: { kind: "permission", path: w.dataDir }, intent: "restore-aside", kept: [w.paths.previous, w.download, w.storeCopy] })],
    ["B2b: ENOSPC copying the store copy into place", w => ({ fault: { op: "copyFile", match: is(`${w.live}.restoring`), code: "ENOSPC", when: "after" }, cause: { kind: "disk" }, intent: "restore-install", kept: [w.paths.previous, w.download, w.storeCopy, w.aside] })],
    ["B3: EACCES putting the previous file back", w => ({ fault: { op: "rename", match: from(w.paths.previous), code: "EACCES" }, cause: { kind: "permission", path: path.dirname(w.program) }, intent: "put-back", kept: [w.paths.previous, w.download, w.storeCopy, w.aside] })],
  ];
  it.each(cases)("%s", async (_name, setUp) => {
    const w = new World({ newAcks: false });
    const c = setUp(w);
    const { end, log } = await update(w, [c.fault]);
    expect(end).toEqual({ outcome: "stuck", words: words.goBackPaused(FROM, c.cause), intent: c.intent });
    expect(log.pages).toEqual([words.goBackPaused(FROM, c.cause)]);
    expect(w.transaction()?.intent).toBe(c.intent);
    expect(c.kept.filter(f => !existsSync(f))).toEqual([]);
    const again = await resume(w);
    expect(again.end).toEqual({ outcome: "rolled-back", cleaned: true, startApp: false });
    expect(holds(w.program, w.old, w.new)).toBe("old");
    expect(contents(w.live)).toEqual({ version: STORE_BEFORE, ids: BEFORE });
  });

  it("B2b's recovery sets aside a store found at the live path without landing on the one already aside, then pauses on ENOSPC", async () => {
    const w = new World({ newAcks: false });
    const fx = w.effects(newLog(), "B2b.before");
    beginUpdate(w.approval, { spawnWatcher: () => undefined, fs: fx.fs, earlierFailure: false });
    expect(await attempt(() => runWatcher(w.file, fx))).toEqual({ outcome: "crashed", point: "B2b.before" });
    const asideStore = path.join(w.aside, "threads.sqlite");
    copyFileSync(asideStore, w.live);
    w.faults = [{ op: "copyFile", match: is(`${w.live}.restoring`), code: "ENOSPC", when: "after" }];
    const { end } = await resume(w);
    w.faults = [];
    expect(end).toEqual({ outcome: "stuck", words: words.goBackPaused(FROM, { kind: "disk" }), intent: "restore-install" });
    expect([existsSync(asideStore), existsSync(`${asideStore}.1`)]).toEqual([true, true]);
  });
});

describe("an error while writing a failure ending is a crash, never a stop", () => {
  const faults: readonly [string, string, (w: World) => void][] = [
    ["EACCES removing the transaction", "EACCES", w => { w.faults = [{ op: "unlink", match: is(w.file), code: "EACCES" }]; }],
    ["ENOSPC writing the result", "ENOSPC", w => { w.resultFault = "ENOSPC"; }],
  ];
  const points = [["S2.before", true], ["S3.before", true], ["B3.before", false]] as const;
  const cases = points.flatMap(([point, newAcks]) => faults.map(([name, code, inject]) => [point, name, newAcks, code, inject] as const));
  it.each(cases)("an unknown file found at %s, then %s: every file kept, intent unchanged, the next run ends rollback-failed", async (point, _name, newAcks, code, inject) => {
    const w = new World({ newAcks });
    const fx = w.effects(newLog(), point);
    beginUpdate(w.approval, { spawnWatcher: () => undefined, fs: fx.fs, earlierFailure: false });
    expect(await attempt(() => runWatcher(w.file, fx))).toEqual({ outcome: "crashed", point });
    putUnknownFile(w);
    const intent = w.transaction(), kept = w.named();
    expect(kept).toContain(w.download);
    inject(w);
    const log = newLog();
    await expect(resumeWatcher(w.file, w.effects(log))).rejects.toMatchObject({ code });
    w.faults = [];
    w.resultFault = null;
    expect(w.named()).toEqual(kept);
    expect([...w.results.values()].filter(r => r.outcome === "stopped")).toEqual([]);
    expect(w.transaction()).toEqual(intent);
    const again = await resumeWatcher(w.file, w.effects(newLog()));
    expect(again.outcome).toBe("rollback-failed");
    expect(w.transaction()).toBeNull();
    expect(w.named()).toEqual(kept);
  });
});

const nothing = () => undefined;

/** The ways a run reaches B3, each crashed at `B3.before` so a test can change `.previous-<id>` first. */
const asIs = (fx: WatcherEffects): WatcherEffects => fx;
const spawnFails = (fx: WatcherEffects): WatcherEffects => ({ ...fx, spawn: () => { throw new Error("spawn failed"); } });
const toPutBack: readonly [string, () => World, (fx: WatcherEffects) => WatcherEffects][] = [
  ["after B2b restored the copy of the chats", () => new World({ newAcks: false }), asIs],
  ["with no restore needed: T1's spawn failed, so the store was never upgraded", () => new World(), spawnFails],
  ["with no restore needed: there was no store", () => new World({ newAcks: false, noStore: true }), asIs],
];
const savedOldStates: readonly [string, "missing" | "not-old", (file: string) => void][] = [
  ["a regular file with other bytes", "not-old", file => { rmSync(file); writeFileSync(file, "other bytes"); }],
  ["missing", "missing", file => rmSync(file)],
  ["a folder", "not-old", file => { rmSync(file); mkdirSync(file); }],
  ["a named pipe", "not-old", file => { rmSync(file); execFileSync("mkfifo", [file]); }],
  ["a link to nothing", "missing", file => { rmSync(file); symlinkSync(`${file}.gone`, file); }],
  ["a link loop", "missing", file => { rmSync(file); symlinkSync(file, file); }],
];
const putBackCases = toPutBack.flatMap(([way, make, change]) => savedOldStates.map(([state, saved, spoil]) => [way, state, make, change, saved, spoil] as const));

describe("B3 with new at the path and the saved old version not there: rollback-failed with B3's own sentence, nothing moved", () => {
  it.each(putBackCases)("reached %s; the saved file is %s", async (_way, _state, make, change, saved, spoil) => {
    const w = make();
    const hadStore = existsSync(w.live);
    const fx = change(w.effects(newLog(), "B3.before"));
    beginUpdate(w.approval, { spawnWatcher: () => undefined, fs: fx.fs, earlierFailure: false });
    expect(await attempt(() => runWatcher(w.file, fx))).toEqual({ outcome: "crashed", point: "B3.before" });
    expect(w.transaction()?.intent).toBe("put-back");
    spoil(w.paths.previous);
    const { end, log } = await resume(w);
    const sentence = words.rollbackFailedSavedOld({ newVersion: TO, oldVersion: FROM, previous: w.paths.previous, saved, path: w.program, dataFolder: w.dataDir });
    expect(end).toEqual({ outcome: "rollback-failed", words: sentence });
    expect(log.pages).toEqual([sentence]);
    expect(log.deleted).toEqual([w.file]);
    expect(holds(w.program, w.old, w.new)).toBe("new");
    expect(w.transaction()).toBeNull();
    // "Your chats are in <data folder>": the live store there holds the chats from before the update, or there was none and is none.
    expect(hadStore ? contents(w.live) : existsSync(w.live)).toEqual(hadStore ? { version: STORE_BEFORE, ids: BEFORE } : false);
  });
});

describe("the unknown-file page names only the saved versions that are there", () => {
  const cases: readonly [string, "S2.before" | "S3.before", (w: World) => void, (w: World) => readonly [string | null, string | null]][] = [
    ["at S3: .previous and .incoming", "S3.before", nothing, w => [w.paths.previous, w.paths.incoming]],
    ["at S3 with a .incoming that does not match: .previous and the verified download", "S3.before", w => writeFileSync(w.paths.incoming, "partial"), w => [w.paths.previous, w.artifactFile]],
    ["at S2, before .previous exists: only .incoming", "S2.before", nothing, w => [null, w.paths.incoming]],
    ["at S2 with .incoming gone: only the verified download", "S2.before", w => rmSync(w.paths.incoming), w => [null, w.artifactFile]],
    ["at S2 with .incoming gone and the download changed: none", "S2.before", w => { rmSync(w.paths.incoming); writeFileSync(w.artifactFile, "changed"); }, () => [null, null]],
  ];
  it.each(cases)("%s", async (_name, point, change, saved) => {
    const w = new World();
    const fx = w.effects(newLog(), point);
    beginUpdate(w.approval, { spawnWatcher: () => undefined, fs: fx.fs, earlierFailure: false });
    await attempt(() => runWatcher(w.file, fx));
    putUnknownFile(w);
    change(w);
    const [old, next] = saved(w);
    const keeps = w.named();
    const end = await resumeWatcher(w.file, w.effects(newLog()));
    const text = "words" in end ? end.words?.text ?? "" : "";
    expect([w.paths.previous, w.paths.incoming, w.artifactFile].filter(f => text.includes(f))).toEqual([old, next].filter(f => f !== null));
    const sentence = words.unknownFile(w.program, old === null ? null : { version: FROM, path: old }, next === null ? null : { version: TO, path: next });
    expect(end).toEqual({ outcome: "rollback-failed", words: sentence });
    expect(w.results.get("tx1")).toMatchObject({ outcome: "rollback-failed", keeps });
  });
});

/** A transaction left at `launch-new` by a watcher that died during L1 or L2: the path at new, no result. */
async function diedDuringLaunch(w: World, record: "saved" | "not saved"): Promise<InstalledTransaction> {
  const log = newLog();
  const point = record === "saved" ? "L2.before" : "L1.spawned";
  const fx = w.effects(log, point);
  beginUpdate(w.approval, { spawnWatcher: () => undefined, fs: fx.fs, earlierFailure: false });
  const end = await attempt(() => runWatcher(w.file, fx));
  expect(end).toEqual({ outcome: "crashed", point });
  const tx = w.transaction();
  if (tx === null || tx.t1 === undefined) throw new Error("no transaction at launch-new");
  expect(tx.intent).toBe("launch-new");
  expect(tx.t1.record !== undefined).toBe(record === "saved");
  expect(holds(w.program, w.old, w.new)).toBe("new");
  expect(w.results.size).toBe(0);
  return tx;
}

describe("the watcher dies during L1 or L2", () => {
  it("record saved, T1 gone: one retry with a fresh token, then the 60 s rule again", async () => {
    const w = new World();
    const tx = await diedDuringLaunch(w, "saved");
    w.watcherDied();
    const { end, log } = await resume(w);
    expect(log.spawns).toHaveLength(1);
    expect(log.spawns[0]).not.toBe(tx.t1?.token);
    expect(end).toEqual({ outcome: "updated", cleaned: true, startApp: false });
    expect(w.results.get("tx1")).toMatchObject({ outcome: "updated", token: log.spawns[0] });
  });

  it("record saved, T1 gone, and the retry does not acknowledge either: go back, never a second retry", async () => {
    const w = new World();
    await diedDuringLaunch(w, "saved");
    w.watcherDied();
    w.newAcks = false;
    const { end, log } = await resume(w);
    expect(log.spawns).toHaveLength(2);
    expect(end).toEqual({ outcome: "rolled-back", cleaned: true, startApp: false });
  });

  it("record saved and T1's tree still there: stuck, nothing spawned", async () => {
    const w = new World();
    await diedDuringLaunch(w, "saved");
    const { end, log } = await resume(w);
    expect(end).toEqual({ outcome: "stuck", words: words.stuck(TO), intent: "launch-new" });
    expect(log.spawns).toEqual([]);
  });

  it("no record saved: stuck until the boot id changes, then the retry", async () => {
    const w = new World();
    await diedDuringLaunch(w, "not saved");
    w.watcherDied();
    for (let i = 0; i < 2; i++) {
      const { end, log } = await resume(w);
      expect(end).toEqual({ outcome: "stuck", words: words.stuck(TO), intent: "launch-new" });
      expect([log.spawns, log.stops]).toEqual([[], []]);
    }
    w.reboot();
    const { end, log } = await resume(w);
    expect(log.spawns).toHaveLength(1);
    expect(end).toEqual({ outcome: "updated", cleaned: true, startApp: false });
  });

  it("a T1 with a saved record that also says its spawn failed is never taken as stopped: the file is refused and nothing changes", async () => {
    const w = new World({ newAcks: false });
    const fx = w.effects(newLog(), "B1.before");
    beginUpdate(w.approval, { spawnWatcher: () => undefined, fs: fx.fs, earlierFailure: false });
    await attempt(() => runWatcher(w.file, fx));
    const tx = w.transaction();
    if (tx?.t1?.record === undefined) throw new Error("no T1 record at stop-new");
    w.procs.set(tx.t1.record.pid, { alive: true, version: "new", token: tx.t1.token });
    writeFileSync(w.file, JSON.stringify({ ...tx, t1: { ...tx.t1, spawnFailed: true } }));
    const before = w.snapshot();
    const log = newLog();
    expect(await resumeWatcher(w.file, w.effects(log))).toEqual({ outcome: "unreadable" });
    expect([log.ops, log.spawns, log.stops]).toEqual([[], [], []]);
    expect(w.snapshot()).toEqual(before);
  });

  it("stop-new already written: continues at B1, never retries", async () => {
    const w = new World({ newAcks: false });
    const log = newLog();
    const fx = w.effects(log, "B1.before");
    beginUpdate(w.approval, { spawnWatcher: () => undefined, fs: fx.fs, earlierFailure: false });
    await attempt(() => runWatcher(w.file, fx));
    w.newAcks = true;
    const { end, log: after } = await resume(w);
    expect(end.outcome).toBe("rolled-back");
    expect(after.spawns).toHaveLength(1);
    expect(w.results.get("tx1")).toMatchObject({ outcome: "rolled-back" });
  });

  it("at B4, the same steps for T2: no record saved is stuck until the boot id changes, then a fresh T2", async () => {
    const w = new World({ newAcks: false });
    const fx = w.effects(newLog(), "B4.spawned");
    beginUpdate(w.approval, { spawnWatcher: () => undefined, fs: fx.fs, earlierFailure: false });
    expect(await attempt(() => runWatcher(w.file, fx))).toEqual({ outcome: "crashed", point: "B4.spawned" });
    const t2 = w.transaction()?.t2;
    expect([w.transaction()?.intent, t2?.record]).toEqual(["launch-old", undefined]);
    w.watcherDied();
    const stuck = await resume(w);
    // The stuck page names the version whose launch could not be confirmed stopped: T2 is the old one.
    expect(stuck.end).toEqual({ outcome: "stuck", words: words.stuck(FROM), intent: "launch-old" });
    expect(stuck.log.spawns).toEqual([]);
    w.reboot();
    const { end, log } = await resume(w);
    expect(log.spawns).toHaveLength(1);
    expect(log.spawns[0]).not.toBe(t2?.token);
    expect(end).toEqual({ outcome: "rolled-back", cleaned: true, startApp: false });
    expect(w.results.get("tx1")).toMatchObject({ outcome: "rolled-back", token: log.spawns[0] });
  });

  it("accepted is past both rules: the result is written again if missing, then C; nothing spawned or stopped", async () => {
    const w = new World();
    const log = newLog();
    const fx = w.effects(log, "A.before");
    beginUpdate(w.approval, { spawnWatcher: () => undefined, fs: fx.fs, earlierFailure: false });
    await attempt(() => runWatcher(w.file, fx));
    expect(w.transaction()?.intent).toBe("accepted");
    w.newAcks = false;
    const { end, log: after } = await resume(w);
    expect(end.outcome).toBe("updated");
    expect([after.spawns, after.stops]).toEqual([[], []]);
    expect(w.results.get("tx1")).toMatchObject({ outcome: "updated" });
    expect(contents(w.live)).toEqual({ version: STORE_AFTER, ids: MIGRATED });
  });

  it("accepted with the result already dismissed: never B1, even after new chats", async () => {
    const w = new World();
    const log = newLog();
    const fx = w.effects(log, "A.after");
    beginUpdate(w.approval, { spawnWatcher: () => undefined, fs: fx.fs, earlierFailure: false });
    await attempt(() => runWatcher(w.file, fx));
    w.results.clear();
    const { end, log: after } = await resume(w);
    expect(end.outcome).toBe("updated");
    expect([after.spawns, after.stops]).toEqual([[], []]);
    expect(holds(w.program, w.old, w.new)).toBe("new");
  });
});

describe("one mover", () => {
  it("a second watcher that finds update.lock held changes no file", async () => {
    const w = new World();
    const log = newLog();
    beginUpdate(w.approval, { spawnWatcher: () => undefined, fs: w.effects(log).fs, earlierFailure: false });
    const held = acquireFileLock(updateLockFile(w.dataDir));
    if (!held.ok) throw new Error("could not take the lock for the test");
    const before = w.snapshot();
    try {
      for (const run of [runWatcher, resumeWatcher]) {
        const second = newLog();
        expect(await run(w.file, w.effects(second))).toEqual({ outcome: "lock-held" });
        expect([second.ops, second.spawns, second.pages]).toEqual([[], [], []]);
      }
      expect(w.snapshot()).toEqual(before);
    } finally {
      held.lock.release();
    }
  });

  it("a transaction file copied into another data folder changes no file of either copy", async () => {
    const w = new World(), other = new World();
    beginUpdate(w.approval, { spawnWatcher: () => undefined, fs: w.effects(newLog()).fs, earlierFailure: false });
    writeFileSync(other.file, readFileSync(w.file));
    const before = [w.snapshot(), other.snapshot()];
    for (const run of [runWatcher, resumeWatcher]) {
      const log = newLog();
      expect(await run(other.file, other.effects(log))).toEqual({ outcome: "other-copy" });
      expect([log.ops, log.spawns, log.pages, log.ordinary]).toEqual([[], [], [], 0]);
    }
    expect([w.snapshot(), other.snapshot()]).toEqual(before);
  });

  it("a transaction whose copy is not two absolute paths changes no file", async () => {
    const w = new World();
    beginUpdate(w.approval, { spawnWatcher: () => undefined, fs: w.effects(newLog()).fs, earlierFailure: false });
    const tx = w.transaction();
    writeFileSync(w.file, JSON.stringify({ ...tx, copy: { program: path.relative(w.root, w.program), dataDir: w.dataDir } }));
    const before = w.snapshot();
    const log = newLog();
    expect(await runWatcher(w.file, w.effects(log))).toEqual({ outcome: "other-copy" });
    expect([log.ops, log.spawns]).toEqual([[], []]);
    expect(w.snapshot()).toEqual(before);
  });
});

describe("endings outside the matrix", () => {
  it("H: the deadline passed before the watcher ran, the old app closed: stopped too late, never 'did not close', nothing changed", async () => {
    const w = new World();
    const log = newLog();
    beginUpdate(w.approval, { spawnWatcher: () => undefined, fs: w.effects(log).fs, earlierFailure: false });
    w.uptime += 60;
    const { end, log: ran } = await resume(w);
    expect(end).toMatchObject({ outcome: "stopped", words: words.startedTooLate() });
    expect(ran.logged).toEqual(["W1 stopped: the approval deadline passed after the old app closed"]);
    expect(holds(w.program, w.old, w.new)).toBe("old");
    expect(contents(w.live)).toEqual({ version: STORE_BEFORE, ids: BEFORE });
  });

  it("H: the computer restarted before the watcher ran: stopped too late, logged as another boot", async () => {
    const w = new World();
    const log = newLog();
    beginUpdate(w.approval, { spawnWatcher: () => undefined, fs: w.effects(log).fs, earlierFailure: false });
    w.reboot();
    const { end, log: ran } = await resume(w);
    expect(end).toMatchObject({ outcome: "stopped", words: words.startedTooLate() });
    expect(ran.logged).toEqual(["W1 stopped: the computer restarted after the approval"]);
    expect(holds(w.program, w.old, w.new)).toBe("old");
  });

  it("W1: the old app does not close in time: did not close, logged why, nothing moved, no relaunch", async () => {
    const w = new World();
    w.hangOldApp();
    const { end, log } = await update(w);
    expect(end).toEqual({ outcome: "stopped", words: words.didNotClose(), cleaned: true, startApp: false });
    expect(log.logged).toEqual(["W1 stopped: the old app was still running at the approval deadline"]);
    expect(log.spawns).toEqual([]);
    expect(holds(w.program, w.old, w.new)).toBe("old");
  });

  it("W1: an update that reaches the replace logs no stop", async () => {
    const { log } = await update(new World());
    expect(log.logged.filter(line => line.startsWith("W1"))).toEqual([]);
  });

  // At W2 every failed check of the cached files is the bad-download sentence without its bracket part.
  it("W2: a cached list that fails its signature check stops with the bad-download sentence", async () => {
    const w = new World();
    writeFileSync(path.join(w.download, "release.json.sig"), `${"A".repeat(86)}==\n`);
    const { end } = await update(w);
    stoppedBeforeReplace(w, end, words.badDownload(TO, false));
  });

  it("W2: a cached list whose bytes are not the approved ones stops with the bad-download sentence", async () => {
    const w = new World();
    w.approval = { ...w.approval, listDigest: "d".repeat(128) };
    const { end } = await update(w);
    stoppedBeforeReplace(w, end, words.badDownload(TO, false));
  });

  it("W2: a download that does not match the list stops with the bad-download sentence", async () => {
    const w = new World();
    writeFileSync(w.artifactFile, `${readFileSync(w.artifactFile, "utf8").slice(0, -1)}X`);
    const { end } = await update(w);
    stoppedBeforeReplace(w, end, words.badDownload(TO, false));
  });

  it("B2a's entry: a missing store copy is rollback-failed with nothing moved", async () => {
    const w = new World({ newAcks: false });
    const log = newLog();
    const fx = w.effects(log, "B1.after");
    beginUpdate(w.approval, { spawnWatcher: () => undefined, fs: fx.fs, earlierFailure: false });
    await attempt(() => runWatcher(w.file, fx));
    rmSync(w.storeCopy);
    const { end, log: after } = await resume(w);
    const sentence = words.rollbackFailedStoreCopy({ newVersion: TO, oldVersion: FROM, storeCopy: w.storeCopy, previous: w.paths.previous, dataFolder: w.dataDir });
    expect(end).toEqual({ outcome: "rollback-failed", words: sentence });
    expect(after.pages).toEqual([sentence]);
    expect(contents(w.live)).toEqual({ version: STORE_AFTER, ids: MIGRATED });
    expect(existsSync(w.aside)).toBe(false);
    expect(holds(w.program, w.old, w.new)).toBe("new");
    expect(existsSync(w.paths.previous)).toBe(true);
    expect(w.transaction()).toBeNull();
    expect(w.results.get("tx1")).toEqual({ id: "tx1", from: FROM, to: TO, words: sentence, outcome: "rollback-failed", keeps: [w.paths.previous, w.download] });
  });

  it("B2a's entry: a store copy at the wrong version is rollback-failed with nothing moved", async () => {
    const w = new World({ newAcks: false });
    const log = newLog();
    const fx = w.effects(log, "B1.after");
    beginUpdate(w.approval, { spawnWatcher: () => undefined, fs: fx.fs, earlierFailure: false });
    await attempt(() => runWatcher(w.file, fx));
    rmSync(w.storeCopy);
    copyStore(w.dataDir, STORE_BEFORE);
    expect(contents(w.storeCopy).version).toBe(STORE_AFTER);
    const { end } = await resume(w);
    expect(end.outcome).toBe("rollback-failed");
    expect(contents(w.live)).toEqual({ version: STORE_AFTER, ids: MIGRATED });
    expect(existsSync(w.aside)).toBe(false);
  });

  it("B4: the old version does not start either: T2 stopped, rollback-failed with B4's sentence, every file kept", async () => {
    const w = new World({ newAcks: false, oldAcks: false });
    const { end, log } = await update(w);
    const sentence = words.rollbackFailedOldDidNotStart({ newVersion: TO, oldVersion: FROM, path: w.program, dataFolder: w.dataDir, aside: w.aside });
    expect(end).toEqual({ outcome: "rollback-failed", words: sentence });
    expect(log.stops).toHaveLength(2);
    expect(holds(w.program, w.old, w.new)).toBe("old");
    expect(contents(w.live)).toEqual({ version: STORE_BEFORE, ids: BEFORE });
    expect([existsSync(w.aside), existsSync(w.download), existsSync(w.storeCopy)]).toEqual([true, true, true]);
    expect(w.transaction()).toBeNull();
  });

  it("B4: T2's stop cannot be confirmed: stuck, naming the old version", async () => {
    const w = new World({ newAcks: false, oldAcks: false });
    w.unstoppable = "old";
    const { end } = await update(w);
    expect(end).toEqual({ outcome: "stuck", words: words.stuck(FROM), intent: "launch-old" });
    expect(w.transaction()?.intent).toBe("launch-old");
  });

  it("S3: a file the watcher did not put at the path is the unknown file: rollback-failed, touch nothing", async () => {
    const w = new World();
    const log = newLog();
    const fx = w.effects(log, "S3.before");
    beginUpdate(w.approval, { spawnWatcher: () => undefined, fs: fx.fs, earlierFailure: false });
    await attempt(() => runWatcher(w.file, fx));
    putUnknownFile(w);
    // Not through `resume`: invariant 1 is about what the watcher puts at the path, and here the test put it.
    const after = newLog();
    const end = await resumeWatcher(w.file, w.effects(after));
    const sentence = words.unknownFile(w.program, { version: FROM, path: w.paths.previous }, { version: TO, path: w.paths.incoming });
    expect(end).toEqual({ outcome: "rollback-failed", words: sentence });
    expect(after.pages).toEqual([sentence]);
    expect(after.deleted).toEqual([w.file]);
    expect(readFileSync(w.program, "utf8")).toBe("someone else's file");
    expect([existsSync(w.paths.previous), existsSync(w.paths.incoming)]).toEqual([true, true]);
  });

  it("C: a cleanup that fails leaves cleanup, and a watcher resuming it starts the app anyway", async () => {
    const w = new World();
    const denied = (): Fault => ({ op: "removeTree", match: is(w.download), code: "EACCES" });
    const { end } = await update(w, [denied()]);
    expect(end).toEqual({ outcome: "updated", cleaned: false, startApp: false });
    expect(w.transaction()).toMatchObject({ intent: "cleanup", ending: "updated" });
    w.watcherDied();
    w.reboot();
    w.faults = [denied()];
    const { end: retried, log } = await resume(w);
    expect(retried).toEqual({ outcome: "updated", cleaned: false, startApp: true });
    expect([log.spawns, log.stops, log.ordinary]).toEqual([[], [], 1]);
    expect(w.transaction()).toMatchObject({ intent: "cleanup", ending: "updated" });
  });

  it("a stopped result saved before a crash, with the transaction not yet moved on: the resume cleans up and ends stopped", async () => {
    const w = new World();
    const log = newLog();
    const fx = w.effects(log, "W2.before");
    beginUpdate(w.approval, { spawnWatcher: () => undefined, stopAt: fx.stopAt, fs: fx.fs, earlierFailure: false });
    expect(await attempt(() => runWatcher(w.file, fx))).toMatchObject({ outcome: "crashed", point: "W2.before" });
    // stop() wrote the result, then the watcher died before writing the cleanup intent.
    const sentence = disk(w.dataDir);
    w.results.set("tx1", { id: "tx1", from: FROM, to: TO, words: sentence, outcome: "stopped" });
    w.watcherDied();
    const { end } = await resume(w);
    expect(end).toEqual({ outcome: "stopped", words: sentence, cleaned: true, startApp: true });
    expect(w.transaction()).toBeNull();
    expect(holds(w.program, w.old, w.new)).toBe("old");
    expect(contents(w.live)).toEqual({ version: STORE_BEFORE, ids: BEFORE });
  });

  it("a stop before the old version was identified, killed at C: the resume reads the cleanup and finishes it", async () => {
    const w = new World();
    w.hangOldApp();
    const log = newLog();
    const fx = w.effects(log, "C.before");
    beginUpdate(w.approval, { spawnWatcher: () => undefined, stopAt: fx.stopAt, fs: fx.fs, earlierFailure: false });
    expect(await attempt(() => runWatcher(w.file, fx))).toMatchObject({ outcome: "crashed", point: "C.before" });
    w.watcherDied();
    // The cleanup intent on disk has no identities: the old app was never identified.
    const { end } = await resume(w);
    expect(end).toMatchObject({ outcome: "stopped", words: words.didNotClose(), cleaned: true });
    expect(w.transaction()).toBeNull();
    expect(holds(w.program, w.old, w.new)).toBe("old");
  });

  it("C: a stop before the replace whose cleanup fails still starts the app", async () => {
    const w = new World(); w.free = 10;
    const { end, log } = await update(w, [{ op: "removeTree", match: is(w.download), code: "EACCES" }]);
    expect(end).toMatchObject({ outcome: "stopped", cleaned: false, startApp: true });
    expect(log.ordinary).toBe(1);
  });

  it("C retried by an ordinary launch: row C's deletes only, nothing started, no result written; the transaction goes once they succeed", async () => {
    const w = new World();
    await update(w, [{ op: "removeTree", match: is(w.download), code: "EACCES" }]);
    const results = [...w.results.values()];
    const log = newLog();
    const fs = w.effects(log).fs;
    w.faults = [{ op: "removeTree", match: is(w.download), code: "EACCES" }];
    expect(retryCleanup(w.file, fs)).toBe(false);
    expect(w.transaction()).toMatchObject({ intent: "cleanup", ending: "updated" });
    expect(retryCleanup(w.file, fs)).toBe(true);
    expect([w.transaction(), existsSync(w.download), existsSync(w.paths.previous)]).toEqual([null, false, false]);
    expect([...w.results.values()]).toEqual(results);
    expect([log.spawns, log.stops, log.pages, log.ordinary]).toEqual([[], [], [], 0]);
    expect(retryCleanup(w.file, fs)).toBe(true);
  });

  it("C retried by an ordinary launch changes nothing for a transaction not at cleanup, or not this data folder's", async () => {
    const w = new World(), other = new World();
    beginUpdate(w.approval, { spawnWatcher: () => undefined, fs: w.effects(newLog()).fs, earlierFailure: false });
    writeFileSync(other.file, readFileSync(w.file));
    const before = [w.snapshot(), other.snapshot()];
    expect(retryCleanup(w.file, w.effects(newLog()).fs)).toBe(false);
    expect(retryCleanup(other.file, other.effects(newLog()).fs)).toBe(false);
    expect([w.snapshot(), other.snapshot()]).toEqual(before);
  });
});

const spawnNothing = () => undefined;
const next = (w: World) => ({ ...w.approval, id: "tx2" });
/** A new approval for a version other than the leftover transaction's, so its download folder is another one. */
const otherVersion = (w: World) => ({ ...w.approval, id: "tx2", to: "1.6.0" });
/** Row H let go of update.lock: the next taker gets it. */
const lockIsFree = (w: World) => {
  const taken = acquireFileLock(updateLockFile(w.dataDir));
  expect(taken.ok).toBe(true);
  if (taken.ok) taken.lock.release();
};
/** An update that ended `updated` and left `cleanup` because the download folder could not be removed. */
async function leftCleanup(w: World): Promise<void> {
  await update(w, [{ op: "removeTree", match: is(w.download), code: "EACCES" }]);
  expect(w.transaction()).toMatchObject({ id: "tx1", intent: "cleanup" });
}

describe("row H is the one door: a new approval is refused, changing nothing, while the last update is not finished", () => {
  it("a cleanup transaction whose retry succeeds, approving another version: row C's deletes, then the approval is written", async () => {
    const w = new World();
    await leftCleanup(w);
    const begun = beginUpdate(otherVersion(w), { spawnWatcher: spawnNothing, fs: w.effects(newLog()).fs, earlierFailure: false });
    expect(begun).toMatchObject({ kind: "begun", transaction: { id: "tx2", intent: "approved" } });
    expect(w.transaction()).toMatchObject({ id: "tx2", intent: "approved" });
    expect(existsSync(w.download)).toBe(false);
    lockIsFree(w);
  });

  it("a stopped update's cleanup, retried by approving the same version: its download and signed list stay, and the watcher gets past its download check", async () => {
    const w = new World(); w.free = 10;
    const { end } = await update(w, [{ op: "removeTree", match: is(w.download), code: "EACCES" }]);
    expect(end).toMatchObject({ outcome: "stopped", cleaned: false });
    w.free = 1e12;
    const needed = [w.artifactFile, path.join(w.download, "release.json"), path.join(w.download, "release.json.sig")];
    const fx = w.effects(newLog());
    const begun = beginUpdate(next(w), { spawnWatcher: spawnNothing, fs: fx.fs, earlierFailure: false });
    expect(begun).toMatchObject({ kind: "begun", transaction: { id: "tx2", intent: "approved" } });
    expect(needed.filter(f => !existsSync(f))).toEqual([]);
    expect([existsSync(w.paths.previous), existsSync(w.paths.incoming)]).toEqual([false, false]);
    expect(await attempt(() => runWatcher(w.file, fx))).toEqual({ outcome: "updated", cleaned: true, startApp: false });
  });

  it("a cleanup transaction that stays (EACCES on the download folder): cleanup pending, naming that folder, no approval written", async () => {
    const w = new World();
    await leftCleanup(w);
    let spawned = false;
    w.faults = [{ op: "removeTree", match: is(w.download), code: "EACCES" }];
    const before = w.snapshot();
    const begun = beginUpdate(otherVersion(w), { spawnWatcher: () => { spawned = true; }, fs: w.effects(newLog()).fs, earlierFailure: false });
    w.faults = [];
    lockIsFree(w);
    expect(begun).toEqual({ kind: "refused", words: words.cleanupPending(w.download) });
    expect(w.snapshot()).toEqual(before);
    expect(spawned).toBe(false);
  });

  it("a cleanup transaction that stays because .previous cannot be removed: cleanup pending names the program folder, not the download", async () => {
    const w = new World();
    const denied = (): Fault => ({ op: "unlink", match: is(w.paths.previous), code: "EACCES" });
    await update(w, [denied()]);
    expect(w.transaction()).toMatchObject({ id: "tx1", intent: "cleanup" });
    expect([existsSync(w.paths.previous), existsSync(w.download)]).toEqual([true, true]);
    for (const approval of [next(w), otherVersion(w)]) {
      w.faults = [denied()];
      const begun = beginUpdate(approval, { spawnWatcher: spawnNothing, fs: w.effects(newLog()).fs, earlierFailure: false });
      w.faults = [];
      expect(begun).toEqual({ kind: "refused", words: words.cleanupPending(path.dirname(w.program)) });
    }
  });

  it("a cleanup transaction while update.lock is held: cleanup pending, nothing touched", async () => {
    const w = new World();
    await leftCleanup(w);
    const held = acquireFileLock(updateLockFile(w.dataDir));
    if (!held.ok) throw new Error("could not take the lock for the test");
    try {
      const before = w.snapshot();
      const begun = beginUpdate(otherVersion(w), { spawnWatcher: spawnNothing, fs: w.effects(newLog()).fs, earlierFailure: false });
      expect(begun).toEqual({ kind: "refused", words: words.cleanupPending(w.download) });
      expect(w.snapshot()).toEqual(before);
    } finally {
      held.lock.release();
    }
  });

  it("an undismissed rollback-failed result of an earlier update: the earlier-failure sentence, nothing written", () => {
    const w = new World();
    let spawned = false;
    const before = w.snapshot();
    const begun = beginUpdate(w.approval, { spawnWatcher: () => { spawned = true; }, fs: w.effects(newLog()).fs, earlierFailure: true });
    expect(begun).toEqual({ kind: "refused", words: words.earlierFailure() });
    expect(w.snapshot()).toEqual(before);
    expect([spawned, w.transaction()]).toEqual([false, null]);
  });
});

describe("the order of writes", () => {
  it("each row's intent is on disk before its action, and the program folder is flushed after the replace", async () => {
    const w = new World();
    const { log } = await update(w);
    const intents = log.ops.flatMap((op, i) => op === "rename data/updates/installed-update.json.tmp data/updates/installed-update.json" ? [i] : []);
    const at = (needle: string) => log.ops.findIndex(op => op.startsWith(needle));
    const replace = at("rename apps/.Gates-Local.AppImage.incoming-tx1 apps/Gates-Local.AppImage");
    const tx = (n: number) => intents[n] ?? -1;
    // approved, identified, stage, keep-previous, replace, launch-new, launch-new + record, accepted, cleanup
    expect(intents).toHaveLength(9);
    expect(tx(2)).toBeLessThan(at("copyFile data/updates/1.5.0/"));
    expect(tx(3)).toBeLessThan(at("link apps/Gates-Local.AppImage"));
    expect(tx(4)).toBeLessThan(replace);
    expect(tx(3)).toBeLessThan(tx(4));
    const flush = log.ops.indexOf("fsyncDir apps", replace);
    expect(flush).toBeGreaterThan(replace);
    expect(flush).toBeLessThan(tx(5));
  });
});
