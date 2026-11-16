import { brokenForTest } from "@gates-local/update/break-for-test";
import { STARTUP_TOKEN_ENV } from "@gates-local/update/startup";
import { transactionFile, type InstalledTransaction } from "@gates-local/update/installed/transaction";
import * as words from "@gates-local/update/installed/words";
import type { Words } from "@gates-local/update/installed/words";

export const WATCH_FLAG = "--gates-local-update-watch";
// why: a double-click's launch still on its way out must not read as a failed start and go back.
export const PROFILE_LOCK_RETRY_MS = 5_000;

export interface LaunchFacts {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly copy: { readonly program: string; readonly dataDir: string };
  readonly transaction: InstalledTransaction | "unreadable" | null;
  readonly updateLock: "free" | "held";
  readonly rollbackFailed: boolean;
}

export type LaunchKind =
  | { readonly kind: "watcher"; readonly transactionFile: string }
  | { readonly kind: "exit-unchanged"; readonly why: "lock-held" | "not-this-copy" | "no-transaction" | "unreadable" }
  | { readonly kind: "token-launch"; readonly token: string; readonly row: "launch-new" | "launch-old"; readonly profileLockRetryMs: number; readonly admission: "closed"; readonly words: Words }
  | { readonly kind: "token-refused"; readonly why: "no-transaction" | "token-mismatch" | "other-copy" | "unreadable" }
  | { readonly kind: "ordinary" }
  | { readonly kind: "show-earlier-failure"; readonly words: Words }
  | { readonly kind: "say-and-exit"; readonly why: "other-copy" | "updating"; readonly words: Words }
  | { readonly kind: "become-watcher"; readonly transactionFile: string }
  | { readonly kind: "ordinary-after-cleanup"; readonly transactionFile: string }
  | { readonly kind: "transaction-unreadable"; readonly transactionFile: string; readonly words: Words };

export interface UnroutedFacts {
  readonly dataDir: string;
  readonly transaction: InstalledTransaction | "unreadable" | null;
  readonly updateLock: "free" | "held";
  readonly rollbackFailed: boolean;
}

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

  if (brokenForTest("installed-start-skips-the-look")) return { kind: "ordinary" };
  const tx = f.transaction;
  if (tx === null) return startOrEarlierFailure(f.rollbackFailed);
  if (tx === "unreadable") return { kind: "transaction-unreadable", transactionFile: ours, words: words.transactionUnreadable(ours) };
  if (!sameCopy(tx.copy, f.copy)) {
    if (tx.intent === "cleanup" && f.updateLock === "free") return startOrEarlierFailure(f.rollbackFailed);
    return { kind: "say-and-exit", why: "other-copy", words: words.otherCopy(tx.copy.program) };
  }
  if (f.updateLock === "held") return { kind: "say-and-exit", why: "updating", words: words.secondLaunch() };
  if (tx.intent === "cleanup") return { kind: "ordinary-after-cleanup", transactionFile: ours };
  return { kind: "become-watcher", transactionFile: ours };
}
