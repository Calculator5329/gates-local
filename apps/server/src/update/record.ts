// The result of the last update run, left in the data folder for the app to
// show once on its next start: "Updated to v0.2.0, 12 changes", or where it
// stopped, why, and where the log is. The server takes the file when it
// starts (reads it and removes it), so it is shown for one launch only.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Channel, Commit } from "./check.ts";
import type { Step } from "./apply.ts";

export const RECORD_FILE = "update-result.json";

export interface UpdateRecord {
  readonly at: number;
  /** refused: a detached update that did not start (the app shows why). */
  readonly outcome: "updated" | "stopped" | "rollback-failed" | "refused";
  readonly channel?: Channel;
  readonly from?: Commit;
  readonly to?: Commit;
  /** Commits between from and to. */
  readonly changes?: number;
  readonly step?: Step;
  readonly reason?: string;
  readonly commands?: readonly string[];
  readonly logPath?: string;
}

export function writeRecord(dataDir: string, record: UpdateRecord): string {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, RECORD_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, ...record }, null, 2)}\n`);
  renameSync(tmp, file);
  return file;
}

const OUTCOMES = new Set(["updated", "stopped", "rollback-failed", "refused"]);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const commit = (v: unknown): Commit | undefined => {
  if (typeof v !== "object" || v === null) return undefined;
  const c = str((v as { commit?: unknown }).commit);
  const l = str((v as { label?: unknown }).label);
  return c !== undefined && l !== undefined ? { commit: c, label: l } : undefined;
};

/** Reads and removes the record; undefined when there is none or it does not parse (then it is removed too). */
export function takeRecord(dataDir: string): UpdateRecord | undefined {
  const file = path.join(dataDir, RECORD_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  rmSync(file, { force: true });
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (raw["version"] !== 1 || typeof raw["at"] !== "number" || !OUTCOMES.has(String(raw["outcome"]))) return undefined;
  const channel = raw["channel"] === "main" || raw["channel"] === "release" ? raw["channel"] : undefined;
  const from = commit(raw["from"]);
  const to = commit(raw["to"]);
  const step = ["switch", "install", "build-web", "build-desktop"].includes(String(raw["step"])) ? (raw["step"] as Step) : undefined;
  const commands = Array.isArray(raw["commands"]) ? raw["commands"].filter((c): c is string => typeof c === "string") : undefined;
  return {
    at: raw["at"],
    outcome: raw["outcome"] as UpdateRecord["outcome"],
    ...(channel ? { channel } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(typeof raw["changes"] === "number" && Number.isInteger(raw["changes"]) && raw["changes"] >= 0 ? { changes: raw["changes"] } : {}),
    ...(step ? { step } : {}),
    ...(str(raw["reason"]) !== undefined ? { reason: str(raw["reason"])! } : {}),
    ...(commands ? { commands } : {}),
    ...(str(raw["logPath"]) !== undefined ? { logPath: str(raw["logPath"])! } : {}),
  };
}
