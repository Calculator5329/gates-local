import fs from "node:fs";
import path from "node:path";
import type { Channel, Commit } from "./check.ts";
import type { Step } from "./apply.ts";

export const RECORD_FILE = "update-result.json";

/**
 * An installed copy's result, as the watcher wrote it. `id` is the transaction
 * it ended; `link` sends the person to the release page; `token` (updated,
 * rolled-back) is the launch that may open admission on it, and never goes on
 * the wire; `keeps` (rollback-failed) names files no cleanup deletes until the
 * result is dismissed; `shown` means its token launch showed it once already.
 */
export interface InstalledRecord {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly text: string;
  readonly detail?: string;
  readonly link?: true;
  readonly token?: string;
  readonly keeps?: readonly string[];
  readonly shown?: true;
}

/**
 * `refused`: a detached update that did not start, or stopped short of
 * changing more. `rolled-back`: installed copies only. `changes`: commits
 * between `from` and `to`.
 */
export interface UpdateRecord {
  readonly at: number;
  readonly outcome: "updated" | "rolled-back" | "stopped" | "rollback-failed" | "refused";
  readonly channel?: Channel;
  readonly from?: Commit;
  readonly to?: Commit;
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
  // external: Windows cannot open a folder to flush it (EISDIR); the rename is all it has.
  if (process.platform === "win32") return;
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

/**
 * The record, left in place; undefined when there is none or it does not parse
 * (then it is left too). An installed copy reads with this: its token launch
 * must still find its result after a phone's status call read it.
 */
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
