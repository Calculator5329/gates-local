// The watcher's results, kept in the data folder's update-result.json with an
// `installed` part (docs/design/installed-updates.md, section 1). The server
// reads the same file: a token launch opens admission on the result carrying
// its token, and the next ordinary start shows it once.
import { readRecord, writeRecord, type InstalledRecord } from "../../../server/src/update/record.ts";
import type { InstalledResult } from "./watch.ts";

/** Written with the record's flush (file, then folder) before the watcher goes on. */
export function writeResult(dataDir: string, result: InstalledResult, now: () => number = Date.now): void {
  const installed: InstalledRecord = {
    id: result.id,
    from: result.from,
    to: result.to,
    text: result.words.text,
    ...(result.words.detail !== undefined ? { detail: result.words.detail } : {}),
    ...(result.words.link === true ? { link: true as const } : {}),
    ...(result.outcome === "updated" || result.outcome === "rolled-back" ? { token: result.token } : {}),
    ...(result.outcome === "rollback-failed" ? { keeps: result.keeps } : {}),
  };
  writeRecord(dataDir, { at: now(), outcome: result.outcome, installed });
}

/** The result this transaction left, or null when the file holds none, another transaction's, or does not decode. */
export function readResult(dataDir: string, transactionId: string): InstalledResult | null {
  const record = readRecord(dataDir);
  const own = record?.installed;
  if (record === undefined || own === undefined || own.id !== transactionId) return null;
  const words = { text: own.text, ...(own.detail !== undefined ? { detail: own.detail } : {}), ...(own.link === true ? { link: true as const } : {}) };
  const base = { id: own.id, from: own.from, to: own.to, words };
  switch (record.outcome) {
    case "updated":
    case "rolled-back":
      return own.token === undefined ? null : { ...base, outcome: record.outcome, token: own.token };
    case "stopped":
      return { ...base, outcome: "stopped" };
    case "rollback-failed":
      return { ...base, outcome: "rollback-failed", keeps: own.keeps ?? [] };
    default:
      return null;
  }
}

/** An undismissed rollback-failed note: a new update is refused until the person dismisses it. */
export function hasEarlierFailure(dataDir: string): boolean {
  const record = readRecord(dataDir);
  return record?.outcome === "rollback-failed" && record.installed !== undefined;
}
