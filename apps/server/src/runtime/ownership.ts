// Process ownership. A process the app starts is recorded with its PID,
// kernel start time and command line. Only a live process matching all three
// is "ours"; anything else is left alone.
//
// Linux reads /proc. Windows has no /proc: identity comes from one
// PowerShell CIM query (creation date and command line), and a stop is
// `taskkill /T` on the PID tree. The platform and the command runner are
// injectable so both paths are tested on Linux.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { OwnedRecord, decode, parseJson } from "./schemas.ts";

export type ProcIdentity = { pid: number; startTime: string; command: string; state: string };

/** Runs a command synchronously and returns stdout; throws on a non-zero exit. */
export type SyncRunner = (file: string, args: readonly string[]) => string;

const runSync: SyncRunner = (file, args) => execFileSync(file, [...args], { encoding: "utf8", windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });

export interface ProcPlatform {
  readonly platform?: NodeJS.Platform;
  readonly run?: SyncRunner;
}

/** The PowerShell query behind a Windows identity read. */
export const windowsProcQuery = (pid: number) =>
  `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress`;

/** Windows: undefined when the PID is not running (empty output) or the answer is not this PID's. */
export function readWindowsProc(pid: number, run: SyncRunner = runSync): ProcIdentity | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const out = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsProcQuery(pid)]).trim();
    if (out === "") return undefined;
    const v = JSON.parse(out) as unknown;
    if (typeof v !== "object" || v === null) return undefined;
    const { ProcessId, CreationDate, CommandLine } = v as Record<string, unknown>;
    if (ProcessId !== pid || CreationDate === undefined || CreationDate === null) return undefined;
    // CreationDate's JSON form differs across PowerShell versions; compared as an opaque string.
    const startTime = typeof CreationDate === "string" ? CreationDate : JSON.stringify(CreationDate);
    return { pid, startTime, command: typeof CommandLine === "string" ? CommandLine : "", state: "R" };
  } catch {
    return undefined;
  }
}

/** Read the process's identity; undefined when it is gone or a zombie. */
export function readProc(pid: number, on: ProcPlatform = {}): ProcIdentity | undefined {
  if ((on.platform ?? process.platform) === "win32") return readWindowsProc(pid, on.run);
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm (field 2) may contain spaces and parens; fields after the last ')'.
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const state = rest[0] ?? "";
    const startTime = rest[19]; // field 22
    if (!startTime || state === "Z" || state === "X") return undefined;
    const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
    return { pid, startTime, command, state };
  } catch {
    return undefined;
  }
}

export type OwnershipCheck =
  | { kind: "ours"; record: OwnedRecord }
  | { kind: "gone"; record: OwnedRecord }
  | { kind: "not-ours"; record: OwnedRecord; detail: string }
  | { kind: "no-record" };

export function readRecord(file: string): OwnedRecord | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const json = parseJson(text);
  if (!json.ok) return undefined;
  const r = decode(OwnedRecord, json.value);
  return r.ok ? r.value : undefined;
}

export function writeRecord(file: string, record: OwnedRecord): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, file);
}

export function clearRecord(file: string): void {
  rmSync(file, { force: true });
}

export function checkOwnership(file: string, on: ProcPlatform = {}): OwnershipCheck {
  const record = readRecord(file);
  if (!record) return { kind: "no-record" };
  const now = readProc(record.pid, on);
  if (!now) return { kind: "gone", record };
  if (now.startTime !== record.startTime) {
    return { kind: "not-ours", record, detail: `PID ${record.pid} now belongs to a process started at a different time` };
  }
  if (now.command !== record.command) {
    return { kind: "not-ours", record, detail: `PID ${record.pid} now runs "${now.command}", not "${record.command}"` };
  }
  return { kind: "ours", record };
}

export type StopResult =
  | { stopped: true; pid: number }
  | { stopped: false; reason: "no-record" | "gone" }
  | { stopped: false; reason: "not-ours"; detail: string };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function signal(pid: number, sig: NodeJS.Signals, on: ProcPlatform): void {
  if ((on.platform ?? process.platform) === "win32") {
    // No process groups or signals: taskkill the tree (the runners are children), /F for the hard stop.
    try {
      (on.run ?? runSync)("taskkill.exe", ["/PID", String(pid), "/T", ...(sig === "SIGKILL" ? ["/F"] : [])]);
    } catch {
      // already gone, or it refused the polite request; the hard stop follows
    }
    return;
  }
  // The app starts Ollama as a process-group leader so its runners go too.
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      // already gone
    }
  }
}

/**
 * Stop the recorded process only when PID, start time and command all still
 * match. A record that no longer matches is cleared (it is our file) but the
 * process it names is never signalled.
 */
export async function stopOwned(file: string, graceMs = 5000, on: ProcPlatform = {}): Promise<StopResult> {
  const check = checkOwnership(file, on);
  if (check.kind === "no-record") return { stopped: false, reason: "no-record" };
  if (check.kind === "gone") {
    clearRecord(file);
    return { stopped: false, reason: "gone" };
  }
  if (check.kind === "not-ours") {
    clearRecord(file);
    return { stopped: false, reason: "not-ours", detail: check.detail };
  }
  const { pid } = check.record;
  signal(pid, "SIGTERM", on);
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (checkOwnership(file, on).kind !== "ours") break;
    await sleep(50);
  }
  // Re-verify before the hard kill: never SIGKILL a PID that was reused.
  if (checkOwnership(file, on).kind === "ours") {
    signal(pid, "SIGKILL", on);
    for (let i = 0; i < 40 && checkOwnership(file, on).kind === "ours"; i++) await sleep(50);
  }
  clearRecord(file);
  return { stopped: true, pid };
}
