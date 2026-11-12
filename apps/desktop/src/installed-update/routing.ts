// What the launch routing of an installed Linux copy reads before
// decideLaunch (launch-kinds.ts) decides: the transaction, who holds
// update.lock, an earlier failure. Plus the token launch's retry of the
// profile instance lock, and this copy's identity by real paths.
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { acquireFileLock } from "../../../server/src/update/lock.ts";
import { readRecord } from "../../../server/src/update/record.ts";
import { decideUnrouted, type LaunchFacts, type UnroutedFacts } from "./launch-kinds.ts";
import { hasEarlierFailure } from "./results.ts";
import { LOCK_NAME, readTransaction, transactionFile, UnreadableTransaction, UPDATES_FOLDER, type InstalledTransaction } from "./transaction.ts";
import type { Words } from "./words.ts";

export type Copy = LaunchFacts["copy"];

/** The real path of a folder, or of its nearest existing parent with the rest appended: a data folder may not be made yet. */
function realFolder(folder: string): string {
  const resolved = path.resolve(folder);
  const rest: string[] = [];
  let at = resolved;
  while (!existsSync(at)) {
    const parent = path.dirname(at);
    if (parent === at) return resolved;
    rest.unshift(path.basename(at));
    at = parent;
  }
  return path.join(realpathSync(at), ...rest);
}

/** This copy as a transaction names it: the program file's real path (replaceable.ts found it) and the data folder's. */
export const copyOf = (program: string, dataDir: string): Copy => ({ program, dataDir: realFolder(dataDir) });

/**
 * Who holds update.lock, as acquireFileLock judges it: taken and released at
 * once. A dead owner's lock is taken over, so it counts as free. A folder that
 * cannot hold a lock holds none.
 */
export function probeUpdateLock(dataDir: string): "free" | "held" {
  const dir = path.join(dataDir, UPDATES_FOLDER);
  if (!existsSync(dir)) return "free";
  let taken: ReturnType<typeof acquireFileLock>;
  try {
    taken = acquireFileLock(path.join(dir, LOCK_NAME));
  } catch {
    return "free";
  }
  if (!taken.ok) return "held";
  taken.lock.release();
  return "free";
}

function transactionOf(dataDir: string): InstalledTransaction | "unreadable" | null {
  try {
    return readTransaction(transactionFile(dataDir));
  } catch (error) {
    if (error instanceof UnreadableTransaction) return "unreadable";
    throw error;
  }
}

/** The facts for decideLaunch. update.lock is probed only when there is a transaction to resume or a watch to run. */
export function launchFacts(copy: Copy, argv: readonly string[], env: Readonly<Record<string, string | undefined>>): LaunchFacts {
  const transaction = transactionOf(copy.dataDir);
  return {
    argv, env, copy, transaction,
    updateLock: transaction === null ? "free" : probeUpdateLock(copy.dataDir),
    rollbackFailed: hasEarlierFailure(copy.dataDir),
  };
}

/**
 * A token launch's wait (section 2, "Update startup" and "When the watcher
 * dies"): released once a result carries its token; the watcher died when
 * update.lock is free and still no result carries it. The result is read
 * again after the lock, because the watcher writes it before it lets go.
 */
export function tokenWait(dataDir: string, token: string, probeLock: (dataDir: string) => "free" | "held" = probeUpdateLock): "released" | "waiting" | "watcher-died" {
  const released = () => readRecord(dataDir)?.installed?.token === token;
  if (released()) return "released";
  if (probeLock(dataDir) === "held") return "waiting";
  return released() ? "released" : "watcher-died";
}

/** What decideUnrouted reads: this data folder's transaction, update.lock always, an earlier failure. */
export function unroutedFacts(dataDir: string): UnroutedFacts {
  return { dataDir, transaction: transactionOf(dataDir), updateLock: probeUpdateLock(dataDir), rollbackFailed: hasEarlierFailure(dataDir) };
}

/** How main starts the app or says a page for a launch decideUnrouted routed. */
export interface UnroutedActs {
  readonly start: (o?: { readonly page: Words; readonly hold: true }) => void;
  readonly sayAndExit: (words: Words) => void;
}

/** A packaged Linux launch with no program to replace: read first, then start, or say and exit (launch-kinds.ts, decideUnrouted). */
export function routeUnrouted(dataDir: string, act: UnroutedActs): ReturnType<typeof decideUnrouted> {
  const kind = decideUnrouted(unroutedFacts(dataDir));
  switch (kind.kind) {
    case "ordinary":
      act.start();
      break;
    case "show-earlier-failure":
      act.start({ page: kind.words, hold: true });
      break;
    case "say-and-exit":
    case "transaction-unreadable":
      act.sayAndExit(kind.words);
      break;
  }
  return kind;
}

const RETRY_EVERY_MS = 250;

/** The token launch's profile lock: tries now, then every 250 ms until `retryMs` has passed. */
export async function takeProfileLock(request: () => boolean, retryMs: number, timing: { readonly now?: () => number; readonly sleep?: (ms: number) => Promise<void> } = {}): Promise<boolean> {
  const now = timing.now ?? (() => performance.now());
  const sleep = timing.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const until = now() + retryMs;
  for (;;) {
    if (request()) return true;
    if (now() >= until) return false;
    await sleep(RETRY_EVERY_MS);
  }
}
