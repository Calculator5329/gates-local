// The result of the last update run, left in the data folder for the app to
// show on its next start: "Updated to v0.2.0, 12 changes", or where it
// stopped, why, and where the log is. A clone's server takes the file when it
// starts (reads it and removes it), so it is shown for one launch only.
//
// An installed copy's watcher writes its result here too, with an `installed`
// part: the transaction id, the versions, the words, and the token of the
// launch it is for. Its readers use `readRecord`, which never removes the
// file: a token launch must find its own result, and a status call from a
// phone must not consume it first (docs/design/installed-updates.md, 1).
import fs from "node:fs";
import path from "node:path";
import type { Channel, Commit } from "./check.ts";
import type { Step } from "./apply.ts";

export const RECORD_FILE = "update-result.json";

/** An installed copy's result, as the watcher wrote it. */
export interface InstalledRecord {
  /** The transaction it ended. */
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** The sentence (installed-update/words.ts), its second line, and whether it sends the person to the release page. */
  readonly text: string;
  readonly detail?: string;
  readonly link?: true;
  /** updated and rolled-back: the token of the launch that may open admission on it (T1 or T2). Never on the wire. */
  readonly token?: string;
  /** rollback-failed: the files and folders it names; no cleanup deletes them until it is dismissed. */
  readonly keeps?: readonly string[];
  /** The token launch it was for has shown it: the next start does not show it again. */
  readonly shown?: true;
}

export interface UpdateRecord {
  readonly at: number;
  /** refused: a detached update that did not start, or stopped short of changing more (the app shows why). rolled-back: installed copies only. */
  readonly outcome: "updated" | "rolled-back" | "stopped" | "rollback-failed" | "refused";
  readonly channel?: Channel;
  readonly from?: Commit;
  readonly to?: Commit;
  /** Commits between from and to. */
  readonly changes?: number;
  readonly step?: Step;
  readonly reason?: string;
  readonly commands?: readonly string[];
  readonly logPath?: string;
  readonly installed?: InstalledRecord;
}

/** Write, flush the file, rename into place, flush the folder: a reader sees the old result or the new one, and a crash after this keeps it. */
export function writeRecord(dataDir: string, record: UpdateRecord): string {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, RECORD_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify({ version: 1, ...record }, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  flushFolder(dataDir);
  return file;
}

function flushFolder(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

const OUTCOMES = new Set(["updated", "rolled-back", "stopped", "rollback-failed", "refused"]);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const commit = (v: unknown): Commit | undefined => {
  if (typeof v !== "object" || v === null) return undefined;
  const c = str((v as { commit?: unknown }).commit);
  const l = str((v as { label?: unknown }).label);
  return c !== undefined && l !== undefined ? { commit: c, label: l } : undefined;
};

function installed(v: unknown): InstalledRecord | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  const id = str(r["id"]), from = str(r["from"]), to = str(r["to"]), text = str(r["text"]);
  if (id === undefined || from === undefined || to === undefined || text === undefined) return undefined;
  const keeps = Array.isArray(r["keeps"]) ? r["keeps"].filter((k): k is string => typeof k === "string") : undefined;
  return {
    id, from, to, text,
    ...(str(r["detail"]) !== undefined ? { detail: str(r["detail"])! } : {}),
    ...(r["link"] === true ? { link: true as const } : {}),
    ...(str(r["token"]) !== undefined ? { token: str(r["token"])! } : {}),
    ...(keeps ? { keeps } : {}),
    ...(r["shown"] === true ? { shown: true as const } : {}),
  };
}

function decode(text: string): UpdateRecord | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || raw["version"] !== 1 || typeof raw["at"] !== "number" || !OUTCOMES.has(String(raw["outcome"]))) return undefined;
  const channel = raw["channel"] === "main" || raw["channel"] === "release" ? raw["channel"] : undefined;
  const from = commit(raw["from"]);
  const to = commit(raw["to"]);
  const step = ["switch", "install", "build-web", "build-desktop", "start"].includes(String(raw["step"])) ? (raw["step"] as Step) : undefined;
  const commands = Array.isArray(raw["commands"]) ? raw["commands"].filter((c): c is string => typeof c === "string") : undefined;
  const own = installed(raw["installed"]);
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
    ...(own ? { installed: own } : {}),
  };
}

/** The record, left in place; undefined when there is none or it does not parse (then it is left too). */
export function readRecord(dataDir: string): UpdateRecord | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dataDir, RECORD_FILE), "utf8");
  } catch {
    return undefined;
  }
  return decode(text);
}

export function removeRecord(dataDir: string): void {
  fs.rmSync(path.join(dataDir, RECORD_FILE), { force: true });
}

/** Reads and removes the record; undefined when there is none or it does not parse (then it is removed too). */
export function takeRecord(dataDir: string): UpdateRecord | undefined {
  const file = path.join(dataDir, RECORD_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  fs.rmSync(file, { force: true });
  return decode(text);
}
