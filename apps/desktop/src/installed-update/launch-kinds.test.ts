// One row per line of the design's launch table (section 2, "Three kinds of
// launch, one lock rule each") and each refusal.
import { expect, it } from "vitest";
import { STARTUP_TOKEN_ENV } from "../../../server/src/update/startup.ts";
import { decideLaunch, decideUnrouted, WATCH_FLAG, type LaunchFacts, type LaunchKind, type UnroutedFacts } from "./launch-kinds.ts";
import { approve, transactionFile, type InstalledTransaction } from "./transaction.ts";
import * as words from "./words.ts";

const here = { program: "/apps/Gates-Local.AppImage", dataDir: "/home/p/.config/gates-local-installed/data" };
const file = transactionFile(here.dataDir);
const record = { pid: 9, start: "s", uptime: 1 };
const base = approve({ id: "x", copy: here, from: "1.4.0", to: "1.5.0", listDigest: "b".repeat(128), artifact: { platform: "linux", arch: "x64", kind: "appimage", file: "a.AppImage", size: 1, sha512: "a".repeat(128) }, uptime: 1, boot: "b", main: record, server: record });
const ids = { old: { size: 1, sha512: "c".repeat(128) }, new: { size: 1, sha512: "a".repeat(128) }, storeBefore: 4 };
const at = (intent: InstalledTransaction["intent"], extra: Partial<InstalledTransaction> = {}): InstalledTransaction => ({ ...base, ...ids, intent, ...extra });
const launchNew = at("launch-new", { t1: { token: "T1", boot: "b" } });
const launchOld = at("launch-old", { t1: { token: "T1", boot: "b" }, t2: { token: "T2", boot: "b" } });
const elsewhere: InstalledTransaction = { ...launchNew, copy: { ...here, program: "/other/Gates-Local.AppImage" } };

const facts = (f: Partial<LaunchFacts>): LaunchFacts => ({ argv: ["/apps/Gates-Local.AppImage"], env: {}, copy: here, transaction: null, updateLock: "free", rollbackFailed: false, ...f });
const watch = [`/apps/Gates-Local.AppImage`, `${WATCH_FLAG}=${file}`];
const token = (t: string) => ({ [STARTUP_TOKEN_ENV]: t });

const rows: readonly [string, Partial<LaunchFacts>, LaunchKind][] = [
  // Watcher mode: takes only update.lock; held means exit and change nothing.
  ["watcher mode, lock free", { argv: watch, transaction: base }, { kind: "watcher", transactionFile: file }],
  ["watcher mode, lock held", { argv: watch, transaction: base, updateLock: "held" }, { kind: "exit-unchanged", why: "lock-held" }],
  ["watcher mode for another data folder", { argv: ["/apps/x", `${WATCH_FLAG}=/elsewhere/updates/installed-update.json`], transaction: base }, { kind: "exit-unchanged", why: "not-this-copy" }],
  ["watcher mode with no transaction", { argv: watch }, { kind: "exit-unchanged", why: "no-transaction" }],
  ["watcher mode, a transaction naming another copy", { argv: watch, transaction: elsewhere }, { kind: "exit-unchanged", why: "not-this-copy" }],
  ["watcher mode, a transaction that does not decode", { argv: watch, transaction: "unreadable" }, { kind: "exit-unchanged", why: "unreadable" }],
  // Token launch: profile lock with a 5 s retry, token must match the current launch row, admission closed.
  ["token launch T1 at launch-new", { env: token("T1"), transaction: launchNew, updateLock: "held" }, { kind: "token-launch", token: "T1", row: "launch-new", profileLockRetryMs: 5000, admission: "closed", words: words.updateStartup() }],
  ["token launch T2 at launch-old", { env: token("T2"), transaction: launchOld, updateLock: "held" }, { kind: "token-launch", token: "T2", row: "launch-old", profileLockRetryMs: 5000, admission: "closed", words: words.updateStartup() }],
  ["token launch, stale T1 after a fresh T1 replaced it", { env: token("T0"), transaction: launchNew }, { kind: "token-refused", why: "token-mismatch" }],
  ["token launch T1 once the row is launch-old", { env: token("T1"), transaction: launchOld }, { kind: "token-refused", why: "token-mismatch" }],
  ["token launch T1 once accepted", { env: token("T1"), transaction: at("accepted", { t1: { token: "T1", boot: "b" } }) }, { kind: "token-refused", why: "token-mismatch" }],
  ["token launch, no transaction", { env: token("T1") }, { kind: "token-refused", why: "no-transaction" }],
  ["token launch, transaction of another copy", { env: token("T1"), transaction: elsewhere }, { kind: "token-refused", why: "other-copy" }],
  ["token launch, transaction unreadable", { env: token("T1"), transaction: "unreadable" }, { kind: "token-refused", why: "unreadable" }],
  // Ordinary launch, after taking the profile lock.
  ["ordinary, no transaction", {}, { kind: "ordinary" }],
  ["ordinary, no transaction, an undismissed rollback-failed result", { rollbackFailed: true }, { kind: "show-earlier-failure", words: words.earlierFailure() }],
  ["ordinary, transaction of another copy", { transaction: elsewhere }, { kind: "say-and-exit", why: "other-copy", words: words.otherCopy("/other/Gates-Local.AppImage") }],
  // A moved file: the transaction names the old path. At cleanup with the lock free it starts, leaving row C's leftovers alone.
  ["ordinary, another copy's transaction at cleanup, update.lock free: starts", { transaction: { ...elsewhere, intent: "cleanup", ending: "updated" } }, { kind: "ordinary" }],
  ["ordinary, another copy's transaction at cleanup, an undismissed rollback-failed result", { transaction: { ...elsewhere, intent: "cleanup", ending: "updated" }, rollbackFailed: true }, { kind: "show-earlier-failure", words: words.earlierFailure() }],
  ["ordinary, another copy's transaction at cleanup, update.lock held", { transaction: { ...elsewhere, intent: "cleanup", ending: "updated" }, updateLock: "held" }, { kind: "say-and-exit", why: "other-copy", words: words.otherCopy("/other/Gates-Local.AppImage") }],
  ["ordinary, update.lock held by a live owner", { transaction: launchNew, updateLock: "held" }, { kind: "say-and-exit", why: "updating", words: words.secondLaunch() }],
  ["ordinary, update.lock free or its owner dead", { transaction: launchNew }, { kind: "become-watcher", transactionFile: file }],
  ["ordinary, this copy's transaction at cleanup, update.lock free: retry row C, then start", { transaction: at("cleanup", { ending: "updated" }) }, { kind: "ordinary-after-cleanup", transactionFile: file }],
  ["ordinary, at cleanup with update.lock held", { transaction: at("cleanup", { ending: "updated" }), updateLock: "held" }, { kind: "say-and-exit", why: "updating", words: words.secondLaunch() }],
  ["ordinary, a transaction that does not decode", { transaction: "unreadable" }, { kind: "transaction-unreadable", transactionFile: file, words: words.transactionUnreadable(file) }],
  ["an empty token is no token", { env: token(""), transaction: launchNew }, { kind: "become-watcher", transactionFile: file }],
];

it.each(rows)("%s", (_name, f, expected) => {
  expect(decideLaunch(facts(f))).toEqual(expected);
});

// A packaged Linux launch with no program file to replace (a renamed file, a
// lowercase .appimage, AppRun with APPIMAGE unset) shares the data folder, so
// it reads the same transaction and lock before it opens anything.
const unrouted = (f: Partial<UnroutedFacts>): UnroutedFacts => ({ dataDir: here.dataDir, transaction: null, updateLock: "free", rollbackFailed: false, ...f });
const unroutedRows: readonly [string, Partial<UnroutedFacts>, LaunchKind][] = [
  ["no program, nothing there: starts as before", {}, { kind: "ordinary" }],
  ["no program, an undismissed rollback-failed result", { rollbackFailed: true }, { kind: "show-earlier-failure", words: words.earlierFailure() }],
  ["no program, a go-back paused between B2a and B2b", { transaction: at("restore-install") }, { kind: "say-and-exit", why: "other-copy", words: words.otherCopy(here.program) }],
  // The lock first: a watcher holding it reopens the app by itself, so "start that copy" would not be true.
  ["no program, an update in flight with the lock held", { transaction: launchNew, updateLock: "held" }, { kind: "say-and-exit", why: "updating", words: words.secondLaunch() }],
  ["no program, a transaction that does not decode with the lock held", { transaction: "unreadable", updateLock: "held" }, { kind: "say-and-exit", why: "updating", words: words.secondLaunch() }],
  // At cleanup the store is final; only row C's leftovers remain, and they stay for the copy that owns them.
  ["no program, a transaction at cleanup with the lock free: starts", { transaction: at("cleanup", { ending: "updated" }) }, { kind: "ordinary" }],
  ["no program, at cleanup with an undismissed rollback-failed result", { transaction: at("cleanup", { ending: "updated" }), rollbackFailed: true }, { kind: "show-earlier-failure", words: words.earlierFailure() }],
  ["no program, at cleanup with the lock held", { transaction: at("cleanup", { ending: "updated" }), updateLock: "held" }, { kind: "say-and-exit", why: "updating", words: words.secondLaunch() }],
  ["no program, the lock held with no transaction", { updateLock: "held" }, { kind: "say-and-exit", why: "updating", words: words.secondLaunch() }],
  ["no program, a transaction that does not decode", { transaction: "unreadable" }, { kind: "transaction-unreadable", transactionFile: file, words: words.transactionUnreadable(file) }],
];

it.each(unroutedRows)("%s", (_name, f, expected) => {
  expect(decideUnrouted(unrouted(f))).toEqual(expected);
});
