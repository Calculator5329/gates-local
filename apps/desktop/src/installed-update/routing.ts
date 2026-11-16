import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { acquireFileLock } from "@gates-local/update/lock";
import { readRecord } from "@gates-local/update/record";
import { decideUnrouted, type LaunchFacts, type UnroutedFacts } from "./launch-kinds.ts";
import { hasEarlierFailure } from "./results.ts";
import { LOCK_NAME, readTransaction, transactionFile, UnreadableTransaction, UPDATES_FOLDER, type InstalledTransaction } from "@gates-local/update/installed/transaction";
import type { Words } from "@gates-local/update/installed/words";

export type Copy = LaunchFacts["copy"];

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

export const copyOf = (program: string, dataDir: string): Copy => ({ program, dataDir: realFolder(dataDir) });

export function probeUpdateLock(dataDir: string): "free" | "held" {
  const dir = path.join(dataDir, UPDATES_FOLDER);
  if (!existsSync(dir)) return "free";
  let taken: ReturnType<typeof acquireFileLock>;
  try {
    taken = acquireFileLock(path.join(dir, LOCK_NAME));
  } catch {
    // why: a folder that cannot hold a lock holds no other process's either.
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

export function launchFacts(copy: Copy, argv: readonly string[], env: Readonly<Record<string, string | undefined>>): LaunchFacts {
  const transaction = transactionOf(copy.dataDir);
  return {
    argv, env, copy, transaction,
    updateLock: transaction === null ? "free" : probeUpdateLock(copy.dataDir),
    rollbackFailed: hasEarlierFailure(copy.dataDir),
  };
}

export function tokenWait(dataDir: string, token: string, probeLock: (dataDir: string) => "free" | "held" = probeUpdateLock): "released" | "waiting" | "watcher-died" {
  const released = () => readRecord(dataDir)?.installed?.token === token;
  if (released()) return "released";
  if (probeLock(dataDir) === "held") return "waiting";
  return released() ? "released" : "watcher-died";
}

export function unroutedFacts(dataDir: string): UnroutedFacts {
  return { dataDir, transaction: transactionOf(dataDir), updateLock: probeUpdateLock(dataDir), rollbackFailed: hasEarlierFailure(dataDir) };
}

export interface UnroutedActs {
  readonly start: (o?: { readonly page: Words; readonly hold: true }) => void;
  readonly sayAndExit: (words: Words) => void;
}

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
