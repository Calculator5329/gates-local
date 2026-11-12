// What a launch of an installed Linux copy must do while an update may be in
// flight: the design's "three kinds of launch, one lock rule each"
// (docs/design/installed-updates.md, section 2). A pure decision; the caller
// takes the locks, reads the files and acts on the answer.
//
// The caller has already taken the profile instance lock for an ordinary
// launch (a token launch takes it itself, retrying for up to 5 s; watcher mode
// never takes it). `updateLock` is who holds `update.lock` as
// `acquireFileLock` judges it: "held" means a live owner other than this
// process; an owner that is dead by pid and start time counts as free,
// because the lock can be taken over.
import { STARTUP_TOKEN_ENV } from "../../../server/src/update/startup.ts";
import { transactionFile, type InstalledTransaction } from "./transaction.ts";
import * as words from "./words.ts";
import type { Words } from "./words.ts";

/** Passed only by the old main at row H: `--gates-local-update-watch=<transaction file>`. */
export const WATCH_FLAG = "--gates-local-update-watch";
/** How long a token launch retries the profile instance lock, so a double-click on its way out cannot cause a false go-back. */
export const PROFILE_LOCK_RETRY_MS = 5_000;

export interface LaunchFacts {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** This copy: the real paths of its program file and its data folder. */
  readonly copy: { readonly program: string; readonly dataDir: string };
  /** The transaction in this data folder; "unreadable" when the file is there and does not decode. */
  readonly transaction: InstalledTransaction | "unreadable" | null;
  readonly updateLock: "free" | "held";
  /** An undismissed `rollback-failed` result exists. */
  readonly rollbackFailed: boolean;
}

export type LaunchKind =
  /** Take only update.lock (the caller), then run the watcher on this file. No profile lock, no server. */
  | { readonly kind: "watcher"; readonly transactionFile: string }
  /** Watcher mode that must change nothing: exit. */
  | { readonly kind: "exit-unchanged"; readonly why: "lock-held" | "not-this-copy" | "no-transaction" | "unreadable" }
  /** Take the profile lock retrying for `profileLockRetryMs`, start the server with admission closed, show the status page, ack on ready. */
  | { readonly kind: "token-launch"; readonly token: string; readonly row: "launch-new" | "launch-old"; readonly profileLockRetryMs: number; readonly admission: "closed"; readonly words: Words }
  /** A token that is not the current launch row's: exit without starting anything. */
  | { readonly kind: "token-refused"; readonly why: "no-transaction" | "token-mismatch" | "other-copy" | "unreadable" }
  | { readonly kind: "ordinary" }
  /** Before starting the server: the earlier failure page, whose one button carries on with a normal start. */
  | { readonly kind: "show-earlier-failure"; readonly words: Words }
  /** Release the profile lock, say this, exit. */
  | { readonly kind: "say-and-exit"; readonly why: "other-copy" | "updating"; readonly words: Words }
  /** Release the profile lock, then carry on in this process as the watcher (taking update.lock under the watcher-mode rule). */
  | { readonly kind: "become-watcher"; readonly transactionFile: string }
  /**
   * This copy's transaction is at `cleanup`: keep the profile lock, take
   * update.lock, call `retryCleanup` once, release update.lock, then start
   * normally whatever it returned.
   */
  | { readonly kind: "ordinary-after-cleanup"; readonly transactionFile: string }
  /** A transaction file is there and does not decode: show this page and start no server. */
  | { readonly kind: "transaction-unreadable"; readonly transactionFile: string; readonly words: Words };

/**
 * A packaged Linux launch with no program file to replace (replaceable.ts
 * found none: a renamed file, a lowercase .appimage, AppRun with APPIMAGE
 * unset). It shares the data folder, so it reads the same transaction and
 * lock, holding the profile lock as an ordinary launch does.
 */
export interface UnroutedFacts {
  readonly dataDir: string;
  readonly transaction: InstalledTransaction | "unreadable" | null;
  /** Probed whether or not there is a transaction: a watcher holds it from row H on. */
  readonly updateLock: "free" | "held";
  readonly rollbackFailed: boolean;
}

/**
 * It never becomes the watcher and never opens the store while a transaction
 * is there: a go-back paused between B2a and B2b has no threads.sqlite, and
 * a server started here would make an empty one. The copy the transaction
 * names finishes it. The lock is read first: a watcher holding it reopens the
 * app by itself. A transaction at `cleanup` with the lock free starts like no
 * transaction: the store is final, row C only removes leftovers, and those
 * stay for the copy that owns them, so a moved file is never stranded.
 */
export function decideUnrouted(f: UnroutedFacts): Extract<LaunchKind, { kind: "ordinary" | "show-earlier-failure" | "say-and-exit" | "transaction-unreadable" }> {
  if (f.updateLock === "held") return { kind: "say-and-exit", why: "updating", words: words.secondLaunch() };
  const tx = f.transaction;
  if (tx === "unreadable") {
    const file = transactionFile(f.dataDir);
    return { kind: "transaction-unreadable", transactionFile: file, words: words.transactionUnreadable(file) };
  }
  if (tx !== null && tx.intent !== "cleanup") return { kind: "say-and-exit", why: "other-copy", words: words.otherCopy(tx.copy.program) };
  return startOrEarlierFailure(f.rollbackFailed);
}

const startOrEarlierFailure = (rollbackFailed: boolean): Extract<LaunchKind, { kind: "ordinary" | "show-earlier-failure" }> =>
  rollbackFailed ? { kind: "show-earlier-failure", words: words.earlierFailure() } : { kind: "ordinary" };

const sameCopy = (a: LaunchFacts["copy"], b: LaunchFacts["copy"]): boolean => a.program === b.program && a.dataDir === b.dataDir;

function watchTarget(argv: readonly string[]): string | null {
  const prefix = `${WATCH_FLAG}=`;
  const arg = argv.find(a => a.startsWith(prefix));
  return arg === undefined ? null : arg.slice(prefix.length);
}

export function decideLaunch(f: LaunchFacts): LaunchKind {
  const ours = transactionFile(f.copy.dataDir);
  const watching = watchTarget(f.argv);
  if (watching !== null) {
    if (watching !== ours) return { kind: "exit-unchanged", why: "not-this-copy" };
    if (f.updateLock === "held") return { kind: "exit-unchanged", why: "lock-held" };
    if (f.transaction === null) return { kind: "exit-unchanged", why: "no-transaction" };
    if (f.transaction === "unreadable") return { kind: "exit-unchanged", why: "unreadable" };
    if (!sameCopy(f.transaction.copy, f.copy)) return { kind: "exit-unchanged", why: "not-this-copy" };
    return { kind: "watcher", transactionFile: ours };
  }

  const token = f.env[STARTUP_TOKEN_ENV];
  if (token !== undefined && token !== "") {
    const tx = f.transaction;
    if (tx === null) return { kind: "token-refused", why: "no-transaction" };
    if (tx === "unreadable") return { kind: "token-refused", why: "unreadable" };
    if (!sameCopy(tx.copy, f.copy)) return { kind: "token-refused", why: "other-copy" };
    const row = tx.intent === "launch-new" && tx.t1?.token === token ? "launch-new" : tx.intent === "launch-old" && tx.t2?.token === token ? "launch-old" : null;
    if (row === null) return { kind: "token-refused", why: "token-mismatch" };
    return { kind: "token-launch", token, row, profileLockRetryMs: PROFILE_LOCK_RETRY_MS, admission: "closed", words: words.updateStartup() };
  }

  const tx = f.transaction;
  if (tx === null) return startOrEarlierFailure(f.rollbackFailed);
  if (tx === "unreadable") return { kind: "transaction-unreadable", transactionFile: ours, words: words.transactionUnreadable(ours) };
  if (!sameCopy(tx.copy, f.copy)) {
    // A moved file finds the old path's transaction: at cleanup with the lock free it starts, leaving row C's leftovers alone.
    if (tx.intent === "cleanup" && f.updateLock === "free") return startOrEarlierFailure(f.rollbackFailed);
    return { kind: "say-and-exit", why: "other-copy", words: words.otherCopy(tx.copy.program) };
  }
  if (f.updateLock === "held") return { kind: "say-and-exit", why: "updating", words: words.secondLaunch() };
  if (tx.intent === "cleanup") return { kind: "ordinary-after-cleanup", transactionFile: ours };
  return { kind: "become-watcher", transactionFile: ours };
}
