import { readRecord, writeRecord, type InstalledRecord } from "@gates-local/update/record";
import type { InstalledResult } from "./watch.ts";

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

export function hasEarlierFailure(dataDir: string): boolean {
  const record = readRecord(dataDir);
  return record?.outcome === "rollback-failed" && record.installed !== undefined;
}
