import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ProcessRecord } from "@gates-local/update/identity";
import { acquireFileLock, type LockOptions } from "@gates-local/update/lock";
import { verifyManifest, type ReleaseArtifact, type ReleaseManifest } from "@gates-local/update/release-manifest";
import { compare, parseRelease } from "@gates-local/update/semver";
import { exists, identify, ioCode, ioDest, ioPath, isFullDisk, realFileOps, sameIdentity, savedFile, type FileOps, type Identity } from "@gates-local/update/installed/files";
import { inUse } from "@gates-local/update/installed/in-use";
import { flushProgramFolder, holds, keepPrevious, programPaths, putBack, recoverStage, removeKept, removeStaging, renameIntoPlace, type ProgramPaths } from "./linux.ts";
import { asideFolder, copyPath, installCopy, restoreEntry, setAside, STORE_NAME, storeVersion } from "./restore.ts";
import type { StopPoint } from "./stop-points.ts";
import {
  approve, LOCK_NAME, readTransaction, removeTransaction, transactionFile, UnreadableTransaction, UPDATES_FOLDER, writeIntent,
  type Approval, type Ending, type InstalledTransaction, type Intent, type TokenLaunch,
} from "@gates-local/update/installed/transaction";
import * as words from "@gates-local/update/installed/words";
import type { PauseCause, Words } from "@gates-local/update/installed/words";

export const ACK_TIMEOUT_MS = 60_000;

export type Ack = "ready" | "exited" | "timeout";

export type InstalledResult = { readonly id: string; readonly from: string; readonly to: string; readonly words: Words } & (
  | { readonly outcome: "updated" | "rolled-back"; readonly token: string }
  | { readonly outcome: "stopped" }
  | { readonly outcome: "rollback-failed"; readonly keeps: readonly string[] }
);

export interface WatcherEffects {
  readonly spawn: (token: string) => ProcessRecord;
  readonly waitForExit: (record: ProcessRecord, timeoutMs: number) => Promise<boolean>;
  readonly treeGone: (record: ProcessRecord) => boolean;
  readonly stopTree: (record: ProcessRecord) => Promise<boolean>;
  readonly waitForAck: (token: string, record: ProcessRecord, timeoutMs: number) => Promise<Ack>;
  readonly writeResult: (result: InstalledResult) => void;
  readonly readResult: (transactionId: string) => InstalledResult | null;
  // external: Node's os.uptime() counts seconds.
  readonly uptime: () => number;
  readonly bootId: () => string;
  readonly showPage: (words: Words) => void;
  readonly log?: (line: string) => void;
  readonly freeBytes: (dir: string) => number;
  readonly trustedKeys: readonly string[];
  readonly automaticChecks: boolean;
  readonly newToken: () => string;
  readonly startOrdinary: () => void;
  readonly stopAt?: (point: StopPoint) => void;
  readonly fs?: FileOps;
  readonly lock?: LockOptions;
}

export type WatchOutcome =
  | { readonly outcome: "updated" | "rolled-back"; readonly cleaned: boolean; readonly startApp: boolean }
  | { readonly outcome: "stopped"; readonly words: Words | null; readonly cleaned: boolean; readonly startApp: boolean }
  | { readonly outcome: "rollback-failed"; readonly words: Words }
  | { readonly outcome: "stuck"; readonly words: Words; readonly intent: Intent }
  | { readonly outcome: "lock-held" | "no-transaction" | "unreadable" | "other-copy" };

type Finished = Exclude<WatchOutcome, { readonly outcome: "lock-held" | "no-transaction" | "unreadable" | "other-copy" }>;

export interface BeginEffects {
  readonly spawnWatcher: (transactionFile: string) => void;
  readonly earlierFailure: boolean;
  readonly stopAt?: (point: StopPoint) => void;
  readonly fs?: FileOps;
  readonly lock?: LockOptions;
}

export type Begin =
  | { readonly kind: "begun"; readonly transaction: InstalledTransaction }
  | { readonly kind: "refused"; readonly words: Words };

export function beginUpdate(a: Approval, fx: BeginEffects): Begin {
  if (fx.earlierFailure) return { kind: "refused", words: words.earlierFailure() };
  const fs = fx.fs ?? realFileOps;
  const file = transactionFile(a.copy.dataDir);
  const tx = approve(a);
  if (exists(file)) {
    const pending = finishCleanup(file, fs, fx.lock, downloadFolder(tx));
    if (pending !== null) return { kind: "refused", words: pending };
  }
  fs.mkdir(path.dirname(file), 0o700);
  writeIntent(file, tx, fs);
  fx.stopAt?.("H.before");
  fx.spawnWatcher(file);
  fx.stopAt?.("H.after");
  return { kind: "begun", transaction: tx };
}

function finishCleanup(file: string, fs: FileOps, lock: LockOptions | undefined, keep: string): Words | null {
  const tx = readTransaction(file);
  if (tx === null) return null;
  if (tx.intent !== "cleanup" || !ownCopy(file, tx)) throw new Error(`${file} is an unfinished update at ${tx.intent}: the launch routing resumes it first`);
  const acquired = acquireFileLock(path.join(path.dirname(file), LOCK_NAME), lock);
  if (!acquired.ok) return words.cleanupPending(leftOver(tx, keep));
  let cleaned: boolean;
  try {
    cleaned = cleanupFiles(file, tx, fs, keep);
  } finally {
    acquired.lock.release();
  }
  return cleaned ? null : words.cleanupPending(leftOver(tx, keep));
}

function leftOver(tx: InstalledTransaction, keep: string | null): string {
  const p = programPaths(tx.copy.program, tx.id);
  if ([p.previous, p.incoming, p.previousPart].some(exists)) return p.dir;
  const download = downloadFolder(tx);
  if (download !== keep && exists(download)) return download;
  return path.join(tx.copy.dataDir, UPDATES_FOLDER);
}

export const runWatcher = (file: string, fx: WatcherEffects): Promise<WatchOutcome> => watch(file, fx, false);

export const resumeWatcher = (file: string, fx: WatcherEffects): Promise<WatchOutcome> => watch(file, fx, true);

async function watch(file: string, fx: WatcherEffects, resumed: boolean): Promise<WatchOutcome> {
  // why: with no updates folder there is no transaction, and no folder to hold the lock.
  if (!exists(path.dirname(file))) return { outcome: "no-transaction" };
  const acquired = acquireFileLock(path.join(path.dirname(file), LOCK_NAME), fx.lock);
  if (!acquired.ok) return { outcome: "lock-held" };
  let outcome: WatchOutcome;
  try {
    outcome = await underLock(file, fx, resumed);
  } finally {
    acquired.lock.release();
  }
  if ("startApp" in outcome && outcome.startApp) fx.startOrdinary();
  return outcome;
}

const ownCopy = (file: string, tx: InstalledTransaction): boolean =>
  path.isAbsolute(tx.copy.program) && path.isAbsolute(tx.copy.dataDir) && file === transactionFile(tx.copy.dataDir);

async function underLock(file: string, fx: WatcherEffects, resumed: boolean): Promise<WatchOutcome> {
  let tx: InstalledTransaction | null;
  try {
    tx = readTransaction(file);
  } catch (e) {
    if (e instanceof UnreadableTransaction) return { outcome: "unreadable" };
    throw e;
  }
  if (tx === null) return { outcome: "no-transaction" };
  if (!ownCopy(file, tx)) return { outcome: "other-copy" };
  return drive({ file, fx, fs: fx.fs ?? realFileOps, p: programPaths(tx.copy.program, tx.id), resumed, tx, relaunch: false, stopWords: null });
}

interface Run {
  readonly file: string;
  readonly fx: WatcherEffects;
  readonly fs: FileOps;
  readonly p: ProgramPaths;
  readonly resumed: boolean;
  tx: InstalledTransaction;
  relaunch: boolean;
  stopWords: Words | null;
}

type Row = Exclude<Intent, "accepted" | "went-back">;

async function drive(r: Run): Promise<Finished> {
  const settled = settledByResult(r);
  if (settled !== null) return settled;
  for (;;) {
    const intent = r.tx.intent;
    if (intent === "accepted" || intent === "went-back") {
      decided(r, intent);
      continue;
    }
    const done = await row(r, intent);
    if (done !== undefined) return done;
  }
}

function row(r: Run, intent: Row): Promise<Finished | undefined> | Finished | undefined {
  switch (intent) {
    case "approved": return closeOldApp(r);
    case "identified": return beforeReplace(r, r.tx.copy.dataDir, () => recheck(r));
    case "stage": return beforeReplace(r, r.p.dir, () => stageIncoming(r));
    case "keep-previous": return beforeReplace(r, r.p.dir, () => keepOld(r));
    case "replace": return replaceProgram(r);
    case "launch-new": return retryLaunch(r, "t1");
    case "stop-new": return stopNew(r);
    case "restore-aside": return goingBack(r, () => moveStoreAside(r));
    case "restore-install": return goingBack(r, () => installStoreCopy(r));
    case "put-back": return putOldBack(r);
    case "launch-old": return retryLaunch(r, "t2");
    case "cleanup": return cleanup(r);
  }
}

const at = (r: Run, point: StopPoint): void => r.fx.stopAt?.(point);

function write(r: Run, intent: Intent, extra: Partial<InstalledTransaction> = {}): void {
  const next: InstalledTransaction = { ...r.tx, ...extra, intent };
  writeIntent(r.file, next, r.fs);
  r.tx = next;
}

const downloadFolder = (tx: InstalledTransaction): string => path.join(tx.copy.dataDir, UPDATES_FOLDER, tx.to);
const artifactFile = (tx: InstalledTransaction): string => path.join(downloadFolder(tx), tx.artifact.file);

function identities(tx: InstalledTransaction): { readonly old: Identity; readonly next: Identity; readonly storeBefore: number } {
  if (tx.old === undefined || tx.new === undefined || tx.storeBefore === undefined) throw new Error(`${tx.intent} without old, new and storeBefore`);
  return { old: tx.old, next: tx.new, storeBefore: tx.storeBefore };
}

function launchOf(tx: InstalledTransaction, which: "t1" | "t2"): TokenLaunch {
  const t = tx[which];
  if (t === undefined) throw new Error(`${tx.intent} without ${which.toUpperCase()}`);
  return t;
}

const base = (tx: InstalledTransaction) => ({ id: tx.id, from: tx.from, to: tx.to });
const megabytes = (bytes: number, round: (n: number) => number): number => round(bytes / 1_000_000);

const inProgramFolder = (r: Run, file: string): boolean => file.startsWith(`${r.p.dir}${path.sep}`);

function stopSentence(r: Run, e: unknown, folder: string): Words | null {
  const code = ioCode(e);
  if (code === null) return null;
  const tx = r.tx;
  const target = ioDest(e) ?? ioPath(e);
  if (isFullDisk(code)) {
    const volume = target !== null && inProgramFolder(r, target) ? r.p.dir : tx.copy.dataDir;
    return words.disk(volume, tx.to, megabytes(tx.artifact.size, Math.ceil), megabytes(r.fx.freeBytes(volume), Math.floor));
  }
  if (code !== "EROFS" && code !== "EACCES" && code !== "EPERM") return null;
  if (target !== null && inProgramFolder(r, target)) return words.cannotReplace(code === "EROFS" ? "read-only" : "no-permission", tx.to);
  return words.couldNotStartUpdate(target ?? folder);
}

function pauseCause(r: Run, e: unknown): PauseCause | null {
  const code = ioCode(e);
  if (code === null) return null;
  if (isFullDisk(code)) return { kind: "disk" };
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    const file = ioPath(e);
    return { kind: "permission", path: file === null ? r.tx.copy.dataDir : path.dirname(file) };
  }
  return null;
}

function stop(r: Run, sentence: Words, relaunch: boolean): undefined {
  removeStaging(r.p, r.fs);
  r.fx.writeResult({ ...base(r.tx), outcome: "stopped", words: sentence });
  write(r, "cleanup", { ending: "stopped" });
  r.relaunch = relaunch;
  r.stopWords = sentence;
  return undefined;
}

type Decision = undefined | { readonly end: "unknown-file" } | { readonly end: "stopped"; readonly words: Words };

function beforeReplace(r: Run, folder: string, body: () => Decision): Finished | undefined {
  let decision: Decision;
  try {
    decision = body();
  } catch (e) {
    const sentence = stopSentence(r, e, folder);
    if (sentence === null) throw e;
    decision = { end: "stopped", words: sentence };
  }
  if (decision === undefined) return undefined;
  return decision.end === "unknown-file" ? unknownFile(r) : stop(r, decision.words, true);
}

type SavedOldNotThere = { readonly end: "saved-old-not-there"; readonly saved: "missing" | "not-old" };
type GoingBackDecision = Exclude<Decision, { readonly end: "stopped" }> | SavedOldNotThere;

function goingBack(r: Run, body: () => GoingBackDecision): Finished | undefined {
  let decision: GoingBackDecision;
  try {
    decision = body();
  } catch (e) {
    const cause = pauseCause(r, e);
    if (cause === null) throw e;
    return stuck(r, words.goBackPaused(r.tx.from, cause));
  }
  if (decision === undefined) return undefined;
  if (decision.end === "unknown-file") return unknownFile(r);
  return rollbackFailed(r, words.rollbackFailedSavedOld({
    newVersion: r.tx.to, oldVersion: r.tx.from, previous: r.p.previous, saved: decision.saved, path: r.p.program, dataFolder: r.tx.copy.dataDir,
  }));
}

function stuck(r: Run, sentence: Words): Finished {
  r.fx.showPage(sentence);
  return { outcome: "stuck", words: sentence, intent: r.tx.intent };
}

function rollbackFailed(r: Run, sentence: Words): Finished {
  const tx = r.tx, dataDir = tx.copy.dataDir;
  const named = [r.p.previous, r.p.incoming, downloadFolder(tx), ...(tx.storeBefore === undefined ? [] : [copyPath(dataDir, tx.storeBefore)]), asideFolder(dataDir, tx.id)];
  r.fx.writeResult({ ...base(tx), outcome: "rollback-failed", words: sentence, keeps: named.filter(exists) });
  removeTransaction(r.file, r.fs);
  r.fx.showPage(sentence);
  return { outcome: "rollback-failed", words: sentence };
}

const matches = (file: string, identity: Identity | undefined): boolean => identity !== undefined && savedFile(file, identity) === "same";

function unknownFile(r: Run): Finished {
  const tx = r.tx, next: Identity = { size: tx.artifact.size, sha512: tx.artifact.sha512 };
  const newAt = [r.p.incoming, artifactFile(tx)].find(file => matches(file, next));
  return rollbackFailed(r, words.unknownFile(
    r.p.program,
    matches(r.p.previous, tx.old) ? { version: tx.from, path: r.p.previous } : null,
    newAt === undefined ? null : { version: tx.to, path: newAt },
  ));
}

function settledByResult(r: Run): Finished | null {
  if (r.tx.intent === "cleanup" || r.tx.intent === "accepted" || r.tx.intent === "went-back") return null;
  const result = r.fx.readResult(r.tx.id);
  if (result === null) return null;
  if (result.outcome === "stopped") {
    write(r, "cleanup", { ending: "stopped" });
    r.stopWords = result.words;
    return null;
  }
  if (result.outcome === "rollback-failed") {
    removeTransaction(r.file, r.fs);
    r.fx.showPage(result.words);
    return { outcome: "rollback-failed", words: result.words };
  }
  return null;
}

async function closeOldApp(r: Run): Promise<Finished | undefined> {
  const { fx, tx } = r;
  at(r, "W1.before");
  const sameBoot = () => tx.deadline.boot === fx.bootId();
  const leftMs = () => sameBoot() ? Math.max(0, (tx.deadline.uptime - fx.uptime()) * 1000) : 0;
  await fx.waitForExit(tx.processes.main, leftMs());
  await fx.waitForExit(tx.processes.server, leftMs());
  const gone = fx.treeGone(tx.processes.main) && fx.treeGone(tx.processes.server);
  const why = !gone ? "the old app was still running at the approval deadline"
    : !sameBoot() ? "the computer restarted after the approval"
    : fx.uptime() >= tx.deadline.uptime ? "the approval deadline passed after the old app closed"
    : null;
  if (why !== null) {
    fx.log?.(`W1 stopped: ${why}`);
    return stop(r, gone ? words.startedTooLate() : words.didNotClose(), false);
  }
  at(r, "W1.after");
  return beforeReplace(r, tx.copy.dataDir, () => {
    const old = identify(r.p.program);
    if (old === null) return { end: "unknown-file" };
    write(r, "identified", { old, new: { size: tx.artifact.size, sha512: tx.artifact.sha512 }, storeBefore: storeVersion(path.join(tx.copy.dataDir, STORE_NAME)) ?? 0 });
    return undefined;
  });
}

const sameArtifact = (a: ReleaseArtifact, b: ReleaseArtifact): boolean =>
  a.platform === b.platform && a.arch === b.arch && a.kind === b.kind && a.file === b.file && a.size === b.size && a.sha512 === b.sha512;

function downloadFailsCheck(r: Run): boolean {
  const tx = r.tx, dir = downloadFolder(tx);
  let list: Buffer, signature: Buffer;
  try {
    list = readFileSync(path.join(dir, "release.json"));
    signature = readFileSync(path.join(dir, "release.json.sig"));
  } catch (e) {
    if (ioCode(e) === "ENOENT") return true;
    throw e;
  }
  let manifest: ReleaseManifest;
  try {
    manifest = verifyManifest(list, signature, r.fx.trustedKeys);
  } catch {
    return true;
  }
  if (createHash("sha512").update(list).digest("hex") !== tx.listDigest) return true;
  const to = parseRelease(`v${tx.to}`), from = parseRelease(`v${tx.from}`);
  if (manifest.version !== tx.to || to === null || from === null || compare(to, from) <= 0) return true;
  const listed = manifest.artifacts.find(a => a.platform === "linux");
  if (listed === undefined || !sameArtifact(listed, tx.artifact)) return true;
  return !sameIdentity(identify(artifactFile(tx)), tx.artifact);
}

function recheck(r: Run): Decision {
  at(r, "W2.before");
  if (downloadFailsCheck(r)) return { end: "stopped", words: words.badDownload(r.tx.to, false) };
  const need = r.tx.artifact.size;
  for (const volume of [r.p.dir, r.tx.copy.dataDir]) {
    const free = r.fx.freeBytes(volume);
    if (free < need) return { end: "stopped", words: words.disk(volume, r.tx.to, megabytes(need, Math.ceil), megabytes(free, Math.floor)) };
  }
  at(r, "W2.after");
  write(r, "stage");
  return undefined;
}

function stageIncoming(r: Run): Decision {
  const { next } = identities(r.tx);
  at(r, "S1.before");
  recoverStage(r.p, artifactFile(r.tx), next, r.fs);
  if (!sameIdentity(identify(r.p.incoming), next)) return { end: "stopped", words: words.badDownload(r.tx.to, r.fx.automaticChecks) };
  at(r, "S1.after");
  write(r, "keep-previous");
  return undefined;
}

function keepOld(r: Run): Decision {
  const { old, next } = identities(r.tx);
  at(r, "S2.before");
  if (holds(r.p.program, old, next) !== "old") return { end: "unknown-file" };
  keepPrevious(r.p, old, r.fs);
  at(r, "S2.after");
  write(r, "replace");
  return undefined;
}

async function replaceProgram(r: Run): Promise<Finished | undefined> {
  const { old, next } = identities(r.tx);
  at(r, "S3.before");
  const found = holds(r.p.program, old, next);
  if (found === "neither") return unknownFile(r);
  if (found === "old") {
    if (!sameIdentity(identify(r.p.incoming), next)) return stop(r, words.badDownload(r.tx.to, r.fx.automaticChecks), true);
    try {
      renameIntoPlace(r.p, r.fs);
    } catch (e) {
      const after = holds(r.p.program, old, next);
      if (after === "neither") return unknownFile(r);
      if (after === "old") {
        const sentence = stopSentence(r, e, r.p.dir);
        if (sentence === null) throw e;
        return stop(r, sentence, true);
      }
    }
    at(r, "S3.rename");
  }
  try {
    flushProgramFolder(r.p, r.fs);
  } catch (e) {
    const cause = pauseCause(r, e);
    if (cause === null) throw e;
    return stuck(r, words.replacePaused(cause));
  }
  at(r, "S3.after");
  return launchNew(r);
}

async function launchNew(r: Run): Promise<undefined> {
  const t1: TokenLaunch = { token: r.fx.newToken(), boot: r.fx.bootId() };
  write(r, "launch-new", { t1 });
  at(r, "L1.before");
  let record: ProcessRecord;
  try {
    record = r.fx.spawn(t1.token);
  } catch {
    write(r, "stop-new", { t1: { ...t1, spawnFailed: true } });
    return undefined;
  }
  at(r, "L1.spawned");
  write(r, "launch-new", { t1: { ...t1, record } });
  at(r, "L1.after");
  at(r, "L2.before");
  const ack = await r.fx.waitForAck(t1.token, record, ACK_TIMEOUT_MS);
  at(r, "L2.after");
  write(r, ack === "ready" ? "accepted" : "stop-new");
  return undefined;
}

function decided(r: Run, intent: "accepted" | "went-back"): void {
  const accepted = intent === "accepted";
  const t = launchOf(r.tx, accepted ? "t1" : "t2");
  at(r, accepted ? "A.before" : "B4.went-back");
  const outcome = accepted ? "updated" : "rolled-back";
  if (r.fx.readResult(r.tx.id)?.outcome !== outcome) {
    r.fx.writeResult({ ...base(r.tx), outcome, token: t.token, words: accepted ? words.updated(r.tx.to) : words.rolledBack(r.tx.to, r.tx.from) });
  }
  at(r, accepted ? "A.after" : "B4.after");
  write(r, "cleanup", { ending: outcome });
}

function cannotBeRunning(r: Run, t: TokenLaunch): boolean {
  if (t.record !== undefined) return r.fx.treeGone(t.record);
  if (t.spawnFailed === true) return true;
  return r.fx.bootId() !== t.boot;
}

async function stopNew(r: Run): Promise<Finished | undefined> {
  const t1 = launchOf(r.tx, "t1");
  at(r, "B1.before");
  const confirmed = t1.record !== undefined ? r.fx.treeGone(t1.record) || await r.fx.stopTree(t1.record) : cannotBeRunning(r, t1);
  if (!confirmed) return stuck(r, words.stuck(r.tx.to));
  at(r, "B1.after");
  const { storeBefore } = identities(r.tx);
  const dataDir = r.tx.copy.dataDir;
  const entry = restoreEntry(dataDir, storeBefore);
  if (entry.kind === "copy-missing" || entry.kind === "copy-wrong") {
    return rollbackFailed(r, words.rollbackFailedStoreCopy({ newVersion: r.tx.to, oldVersion: r.tx.from, storeCopy: entry.copy, previous: r.p.previous, dataFolder: dataDir }));
  }
  return goingBack(r, () => {
    write(r, entry.kind === "restore" ? "restore-aside" : "put-back");
    return undefined;
  });
}

function moveStoreAside(r: Run): undefined {
  at(r, "B2a.before");
  setAside(r.tx.copy.dataDir, r.tx.id, r.fs, name => at(r, `B2a.rename.${name}`));
  at(r, "B2a.after");
  write(r, "restore-install");
  return undefined;
}

function installStoreCopy(r: Run): undefined {
  const { storeBefore } = identities(r.tx);
  at(r, "B2b.before");
  installCopy(r.tx.copy.dataDir, r.tx.id, storeBefore, r.fs, point => at(r, point === "flush" ? "B2b.flush" : "B2b.rename"));
  at(r, "B2b.after");
  write(r, "put-back");
  return undefined;
}

async function putOldBack(r: Run): Promise<Finished | undefined> {
  const { old, next } = identities(r.tx);
  const paused = goingBack(r, () => {
    at(r, "B3.before");
    const found = holds(r.p.program, old, next);
    if (found === "neither") return { end: "unknown-file" };
    if (found === "new") {
      const saved = savedFile(r.p.previous, old);
      if (saved !== "same") return { end: "saved-old-not-there", saved: saved === "missing" ? "missing" : "not-old" };
      putBack(r.p, r.fs);
    } else {
      flushProgramFolder(r.p, r.fs);
    }
    at(r, "B3.after");
    return undefined;
  });
  if (paused !== undefined) return paused;
  return launchOld(r);
}

async function launchOld(r: Run): Promise<Finished | undefined> {
  const t2: TokenLaunch = { token: r.fx.newToken(), boot: r.fx.bootId() };
  write(r, "launch-old", { t2 });
  at(r, "B4.before");
  const didNotStart = () => rollbackFailed(r, words.rollbackFailedOldDidNotStart({
    newVersion: r.tx.to, oldVersion: r.tx.from, path: r.p.program, dataFolder: r.tx.copy.dataDir, aside: asideFolder(r.tx.copy.dataDir, r.tx.id),
  }));
  let record: ProcessRecord;
  try {
    record = r.fx.spawn(t2.token);
  } catch {
    return didNotStart();
  }
  at(r, "B4.spawned");
  write(r, "launch-old", { t2: { ...t2, record } });
  const ack = await r.fx.waitForAck(t2.token, record, ACK_TIMEOUT_MS);
  if (ack === "ready") {
    write(r, "went-back");
    return undefined;
  }
  if (!(r.fx.treeGone(record) || await r.fx.stopTree(record))) return stuck(r, words.stuck(r.tx.from));
  return didNotStart();
}

async function retryLaunch(r: Run, which: "t1" | "t2"): Promise<Finished | undefined> {
  const { old, next } = identities(r.tx);
  const found = holds(r.p.program, old, next);
  if (which === "t1" && found === "old") {
    // why: T1 can only have started the old version, so go back; B3 finds old there.
    write(r, "stop-new");
    return undefined;
  }
  if (found !== (which === "t1" ? "new" : "old")) return unknownFile(r);
  if (!cannotBeRunning(r, launchOf(r.tx, which))) return stuck(r, words.stuck(which === "t1" ? r.tx.to : r.tx.from));
  return which === "t1" ? launchNew(r) : launchOld(r);
}

function noAppRunning(r: Run): boolean {
  const { main, server } = r.tx.processes;
  const records = [main, server, r.tx.t1?.record, r.tx.t2?.record].filter(rec => rec !== undefined);
  return records.every(rec => r.fx.treeGone(rec));
}

function cleanupFiles(file: string, tx: InstalledTransaction, fs: FileOps, keep: string | null = null): boolean {
  try {
    removeKept(programPaths(tx.copy.program, tx.id), fs);
    const download = downloadFolder(tx);
    if (download !== keep && inUse(download) === null) fs.removeTree(download);
    removeTransaction(file, fs);
  } catch (e) {
    if (ioCode(e) === null) throw e;
    return false;
  }
  return true;
}

export function retryCleanup(file: string, fs: FileOps = realFileOps): boolean {
  let tx: InstalledTransaction | null;
  try {
    tx = readTransaction(file);
  } catch (e) {
    if (e instanceof UnreadableTransaction) return false;
    throw e;
  }
  if (tx === null) return true;
  if (!ownCopy(file, tx) || tx.intent !== "cleanup") return false;
  return cleanupFiles(file, tx, fs);
}

function cleanup(r: Run): Finished {
  const ending: Ending = r.tx.ending ?? "stopped";
  at(r, "C.before");
  const cleaned = cleanupFiles(r.file, r.tx, r.fs);
  if (cleaned) at(r, "C.after");
  const startApp = r.relaunch || (r.resumed && noAppRunning(r));
  if (ending === "stopped") return { outcome: "stopped", words: r.stopWords ?? r.fx.readResult(r.tx.id)?.words ?? null, cleaned, startApp };
  return { outcome: ending, cleaned, startApp };
}
