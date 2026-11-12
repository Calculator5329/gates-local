// What the launch routing reads before it decides (section 2, three kinds of
// launch): the transaction, who holds update.lock, an earlier failure, and
// the token launch's retry of the profile lock.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireFileLock } from "../../../server/src/update/lock.ts";
import { copyOf, launchFacts, probeUpdateLock, routeUnrouted, takeProfileLock, tokenWait } from "./routing.ts";
import { writeResult } from "./results.ts";
import { approve, LOCK_NAME, transactionFile, writeIntent } from "./transaction.ts";
import { earlierFailure, otherCopy, secondLaunch } from "./words.ts";

const roots: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function dataDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "iu-routing-"));
  roots.push(root);
  mkdirSync(path.join(root, "updates"));
  return root;
}
const lockFile = (dir: string) => path.join(dir, "updates", LOCK_NAME);
/** The watcher writes the result, then lets go of the lock; the token launch's first read came before both. */
function lockFreesAfterTheResult(dir: string): "free" {
  writeResult(dir, { id: "tx", from: "1", to: "2", outcome: "updated", token: "t1", words: { text: "x" } });
  return "free";
}
/** What a launch with no program to replace did: started the app (with what), or said a page. */
function route(dir: string): { started: unknown[]; said: string[] } {
  const seen: { started: unknown[]; said: string[] } = { started: [], said: [] };
  routeUnrouted(dir, { start: (o) => { seen.started.push(o ?? {}); }, sayAndExit: (w) => { seen.said.push(w.text); } });
  return seen;
}

describe("launch routing facts", () => {
  it("RT-01 update.lock is held only by a live owner other than this process; a dead owner's lock counts as free", () => {
    const dir = dataDir();
    expect(probeUpdateLock(dir)).toBe("free");
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    pids.push(child.pid!);
    const taken = acquireFileLock(lockFile(dir), { pid: child.pid! });
    expect(taken.ok).toBe(true);
    expect(probeUpdateLock(dir)).toBe("held");
    child.kill("SIGKILL");
    return new Promise<void>(resolve => child.once("exit", () => {
      expect(probeUpdateLock(dir)).toBe("free");
      // The probe leaves no lock of its own behind.
      expect(acquireFileLock(lockFile(dir)).ok).toBe(true);
      resolve();
    }));
  });

  it("RT-02 the facts: no transaction, an unreadable one, an earlier failure", () => {
    const dir = dataDir();
    const copy = { program: "/apps/Gates-Local.AppImage", dataDir: dir };
    expect(launchFacts(copy, ["/app"], {})).toMatchObject({ transaction: null, updateLock: "free", rollbackFailed: false });
    writeFileSync(transactionFile(dir), "{");
    expect(launchFacts(copy, ["/app"], {}).transaction).toBe("unreadable");
    rmSync(transactionFile(dir));
    writeResult(dir, { id: "tx", from: "1", to: "2", outcome: "rollback-failed", keeps: [], words: { text: "x" } });
    expect(launchFacts(copy, ["/app"], {}).rollbackFailed).toBe(true);
  });

  it("RT-03 this copy is named by real paths, and a data folder not made yet by its resolved path", () => {
    const dir = dataDir();
    const link = path.join(path.dirname(dir), `${path.basename(dir)}-link`);
    roots.push(link);
    symlinkSync(dir, link);
    expect(copyOf("/apps/G.AppImage", link)).toEqual({ program: "/apps/G.AppImage", dataDir: realpathSync(dir) });
    expect(copyOf("/apps/G.AppImage", path.join(dir, "not-yet", ".."))).toEqual({ program: "/apps/G.AppImage", dataDir: realpathSync(dir) });
    expect(copyOf("/apps/G.AppImage", path.join(dir, "missing"))).toEqual({ program: "/apps/G.AppImage", dataDir: path.join(realpathSync(dir), "missing") });
  });

  it("RT-05 a token launch waits while the watcher holds update.lock, opens on a result carrying its token, and says the watcher died otherwise", () => {
    const dir = dataDir();
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    pids.push(child.pid!);
    expect(acquireFileLock(lockFile(dir), { pid: child.pid! }).ok).toBe(true);
    expect(tokenWait(dir, "t1")).toBe("waiting");
    // Another launch's result does not release this one.
    writeResult(dir, { id: "tx", from: "1", to: "2", outcome: "rolled-back", token: "t2", words: { text: "x" } });
    expect(tokenWait(dir, "t1")).toBe("waiting");
    writeResult(dir, { id: "tx", from: "1", to: "2", outcome: "updated", token: "t1", words: { text: "x" } });
    expect(tokenWait(dir, "t1")).toBe("released");
    writeResult(dir, { id: "tx", from: "1", to: "2", outcome: "stopped", words: { text: "x" } });
    expect(tokenWait(dir, "t1")).toBe("waiting");
    child.kill("SIGKILL");
    return new Promise<void>(resolve => child.once("exit", () => {
      expect(tokenWait(dir, "t1")).toBe("watcher-died");
      writeResult(dir, { id: "tx", from: "1", to: "2", outcome: "updated", token: "t1", words: { text: "x" } });
      expect(tokenWait(dir, "t1")).toBe("released");
      resolve();
    }));
  });

  it("RT-07 a result written as update.lock frees releases the token launch: the result is read again after the lock", () => {
    const dir = dataDir();
    expect(tokenWait(dir, "t1", lockFreesAfterTheResult)).toBe("released");
  });

  it("RT-06 a launch with no program to replace reads the transaction and the lock first, and starts nothing while an update is unfinished", () => {
    const program = "/apps/Gates-Local.AppImage";
    // An unfinished transaction (a go-back paused between B2a and B2b): no threads.sqlite, and none is made.
    const paused = dataDir();
    const record = { pid: 9, start: "s", uptime: 1 };
    const tx = approve({ id: "x", copy: { program, dataDir: paused }, from: "1.4.0", to: "1.5.0", listDigest: "b".repeat(128), artifact: { platform: "linux", arch: "x64", kind: "appimage", file: "a.AppImage", size: 1, sha512: "a".repeat(128) }, uptime: 1, boot: "b", main: record, server: record });
    writeIntent(transactionFile(paused), { ...tx, old: { size: 1, sha512: "c".repeat(128) }, new: { size: 1, sha512: "a".repeat(128) }, storeBefore: 4, t1: { token: "T1", boot: "b" }, intent: "restore-install" });
    expect(route(paused)).toEqual({ started: [], said: [otherCopy(program).text] });
    expect(existsSync(path.join(paused, "threads.sqlite"))).toBe(false);
    // update.lock held by a live owner, no transaction yet.
    const held = dataDir();
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    pids.push(child.pid!);
    expect(acquireFileLock(lockFile(held), { pid: child.pid! }).ok).toBe(true);
    expect(route(held)).toEqual({ started: [], said: [secondLaunch().text] });
    // Nothing there: starts as before, once.
    expect(route(dataDir())).toEqual({ started: [{}], said: [] });
    // An earlier failure: the same page routed copies show, before the server.
    const failed = dataDir();
    writeResult(failed, { id: "tx", from: "1", to: "2", outcome: "rollback-failed", keeps: [], words: { text: "x" } });
    expect(route(failed)).toEqual({ started: [{ page: earlierFailure(), hold: true }], said: [] });
  });

  it("RT-08 a launch with no program to replace starts past a cleanup transaction with update.lock free, and leaves it for its copy", () => {
    const dir = dataDir();
    const record = { pid: 9, start: "s", uptime: 1 };
    const tx = approve({ id: "x", copy: { program: "/apps/Gates-Local.AppImage", dataDir: dir }, from: "1.4.0", to: "1.5.0", listDigest: "b".repeat(128), artifact: { platform: "linux", arch: "x64", kind: "appimage", file: "a.AppImage", size: 1, sha512: "a".repeat(128) }, uptime: 1, boot: "b", main: record, server: record });
    writeIntent(transactionFile(dir), { ...tx, old: { size: 1, sha512: "c".repeat(128) }, new: { size: 1, sha512: "a".repeat(128) }, storeBefore: 4, intent: "cleanup", ending: "updated" });
    expect(route(dir)).toEqual({ started: [{}], said: [] });
    expect(existsSync(transactionFile(dir))).toBe(true);
    // A watcher holding update.lock reopens the app by itself: that is what the launch says.
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    pids.push(child.pid!);
    expect(acquireFileLock(lockFile(dir), { pid: child.pid! }).ok).toBe(true);
    expect(route(dir)).toEqual({ started: [], said: [secondLaunch().text] });
  });

  it("RT-04 a token launch retries the profile lock until it frees, and gives up at the limit", async () => {
    let clock = 0;
    const timing = { now: () => clock, sleep: async (ms: number) => { clock += ms; } };
    let tries = 0;
    expect(await takeProfileLock(() => ++tries === 4, 5_000, timing)).toBe(true);
    expect(tries).toBe(4);
    clock = 0;
    tries = 0;
    expect(await takeProfileLock(() => { tries++; return false; }, 5_000, timing)).toBe(false);
    expect(clock).toBeGreaterThanOrEqual(5_000);
    expect(tries).toBeGreaterThan(10);
  });
});
