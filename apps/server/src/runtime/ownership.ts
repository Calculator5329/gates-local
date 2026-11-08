// Process ownership. A process the app starts is recorded with its PID,
// kernel start time and command line. Only a live process matching all three
// is "ours"; anything else is left alone.
//
// Linux reads /proc. Windows has no /proc: identity comes from one
// PowerShell CIM query (creation date and command line). Windows never
// stops a process by PID number (a check-then-kill can hit a reused PID):
// runtime.ts stops the child it spawned through its handle, and a record
// from an earlier run is "adopted" and left running. The platform and the
// command runner are injectable so both paths are tested on Linux.
//
// A live identity is not enough to adopt a port: the recorded process may
// have let go of it (shutting down, cleaning up runners) and another Ollama
// taken it. listenerPid() names the process that holds a listening port.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isIPv4, isIPv6 } from "node:net";
import { endianness } from "node:os";
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

/** The file reads behind the Linux listener lookup (tests inject fixtures). */
export interface ListenerFs {
  readFile(file: string): string;
  readdir(dir: string): string[];
  readlink(file: string): string;
}

const realFs: ListenerFs = {
  readFile: (file) => readFileSync(file, "utf8"),
  readdir: (dir) => readdirSync(dir),
  readlink: (file) => readlinkSync(file),
};

export interface ListenerOptions extends ProcPlatform {
  /** Linux: search only these processes' fds (the recorded or spawned pid); default every /proc/<pid>. */
  readonly pids?: readonly number[];
  /** Linux: the probed address (an IP literal); a listener counts only on it or a wildcard. Default 127.0.0.1. */
  readonly host?: string;
  readonly fs?: ListenerFs;
}

/**
 * The address bytes of a /proc/net/tcp{,6} local_address hex field: 32-bit
 * words printed in host byte order, so each word is reversed on little-endian.
 */
function procAddressBytes(hex: string): number[] | undefined {
  if (!/^[0-9A-Fa-f]+$/.test(hex) || (hex.length !== 8 && hex.length !== 32)) return undefined;
  const bytes: number[] = [];
  for (let w = 0; w < hex.length; w += 8) {
    const word = [0, 2, 4, 6].map((i) => Number.parseInt(hex.slice(w + i, w + i + 2), 16));
    bytes.push(...(endianness() === "LE" ? word.toReversed() : word));
  }
  return bytes;
}

/** The bytes of an IPv4 or IPv6 literal (IPv6 brackets allowed); undefined for anything else. */
function hostBytes(host: string): { family: 4 | 6; bytes: number[] } | undefined {
  const bare = host.replace(/^\[(.*)\]$/, "$1");
  if (isIPv4(bare)) return { family: 4, bytes: bare.split(".").map(Number) };
  if (!isIPv6(bare) || bare.includes("%")) return undefined;
  // Normalise through the URL parser: compressed, IPv4 tail as hex groups.
  const groups = new URL(`http://[${bare}]/`).hostname.slice(1, -1).split(":");
  const gap = groups.indexOf("");
  const full = gap === -1 ? groups : [...groups.slice(0, gap), ...Array.from({ length: 8 - groups.filter(Boolean).length }, () => "0"), ...groups.slice(gap).filter(Boolean)];
  return { family: 6, bytes: full.flatMap((g) => [Number.parseInt(g, 16) >> 8, Number.parseInt(g, 16) & 0xff]) };
}

const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];

/**
 * A listener bound to `local` serves `probed`: the same address, or a
 * wildcard in the probed family. tcp6 [::] also serves IPv4 while sockets are
 * dual-stack, and [::ffff:a.b.c.d] serves a.b.c.d.
 */
function serves(local: number[], probed: { family: 4 | 6; bytes: number[] }, dualStack: boolean): boolean {
  if (local.length === 4) return probed.family === 4 && (same(local, probed.bytes) || local.every((b) => b === 0));
  if (probed.family === 6) return same(local, probed.bytes) || local.every((b) => b === 0);
  if (local.every((b) => b === 0)) return dualStack;
  return same(local.slice(0, 12), MAPPED_PREFIX) && same(local.slice(12), probed.bytes);
}

/**
 * Linux: the inodes of LISTEN sockets on `port` in /proc/net/tcp or
 * /proc/net/tcp6 text; with `host`, only those bound to it or a wildcard.
 */
export function listenInodes(text: string, port: number, host?: string, dualStack = true): string[] {
  const probed = host === undefined ? undefined : hostBytes(host);
  if (host !== undefined && probed === undefined) return [];
  const inodes: string[] = [];
  for (const line of text.split("\n").slice(1)) {
    // sl local_address rem_address st tx:rx tr:when retrnsmt uid timeout inode ...
    const f = line.trim().split(/\s+/);
    const local = f[1];
    if (f.length < 10 || local === undefined || f[3] !== "0A") continue;
    const inode = f[9];
    if (inode === undefined || inode === "0") continue;
    const colon = local.lastIndexOf(":");
    if (Number.parseInt(local.slice(colon + 1), 16) !== port) continue;
    if (probed !== undefined) {
      const bytes = procAddressBytes(local.slice(0, colon));
      if (bytes === undefined || !serves(bytes, probed, dualStack)) continue;
    }
    inodes.push(inode);
  }
  return inodes;
}

/**
 * Linux, synchronous: the process among `pids` (default all) holding a
 * LISTEN socket that serves `host`:`port` (R2-06: a listener on another
 * loopback address with the same port is not it).
 */
export function readLinuxListenerPid(port: number, pids?: readonly number[], fs: ListenerFs = realFs, host = "127.0.0.1"): number | undefined {
  let dualStack = true; // the kernel default, net.ipv6.bindv6only = 0
  try {
    dualStack = fs.readFile("/proc/sys/net/ipv6/bindv6only").trim() !== "1";
  } catch {
    // keep the default
  }
  const inodes = new Set<string>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try {
      text = fs.readFile(file);
    } catch {
      continue;
    }
    for (const inode of listenInodes(text, port, host, dualStack)) inodes.add(inode);
  }
  if (inodes.size === 0) return undefined;
  const candidates = pids ?? fs.readdir("/proc").filter((n) => /^\d+$/.test(n)).map(Number);
  for (const pid of candidates) {
    let fds: string[];
    try {
      fds = fs.readdir(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let link: string;
      try {
        link = fs.readlink(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (m?.[1] !== undefined && inodes.has(m[1])) return pid;
    }
  }
  return undefined;
}

/** The PowerShell query behind a Windows listener read. */
export const windowsListenerQuery = (port: number) =>
  `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop | Select-Object OwningProcess | ConvertTo-Json -Compress`;

/** Windows: the one OwningProcess in the query's answer; undefined when empty, malformed or several differ. */
export function parseWindowsListener(out: string): number | undefined {
  const text = out.trim();
  if (text === "") return undefined;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  const rows = Array.isArray(v) ? (v as unknown[]) : [v];
  const pids = new Set<number>();
  for (const row of rows) {
    const pid = typeof row === "object" && row !== null ? (row as Record<string, unknown>).OwningProcess : undefined;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
    pids.add(pid);
  }
  return pids.size === 1 ? [...pids][0] : undefined;
}

/**
 * The process listening on loopback `port`: Linux matches the LISTEN
 * socket's inode in /proc/net/tcp{,6} against /proc/<pid>/fd links, Windows
 * asks Get-NetTCPConnection. Any other platform, or any failed read, is
 * undefined (never "ours").
 */
export async function listenerPid(port: number, options: ListenerOptions = {}): Promise<number | undefined> {
  const platform = options.platform ?? process.platform;
  try {
    if (platform === "win32") {
      return parseWindowsListener((options.run ?? runSync)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsListenerQuery(port)]));
    }
    if (platform === "linux") return readLinuxListenerPid(port, options.pids, options.fs, options.host);
    return undefined;
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
  /** Windows: ours, from an earlier run, with no handle to stop it through; left running. */
  | { stopped: false; reason: "adopted" }
  | { stopped: false; reason: "not-ours"; detail: string };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** POSIX only. The app starts Ollama as a process-group leader so its runners go too. */
function signal(pid: number, sig: NodeJS.Signals): void {
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
 * process it names is never signalled. On Windows nothing is killed here:
 * a live record is "adopted" (runtime.ts stops its own child by handle).
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
  if ((on.platform ?? process.platform) === "win32") return { stopped: false, reason: "adopted" };
  const { pid } = check.record;
  signal(pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (checkOwnership(file, on).kind !== "ours") break;
    await sleep(50);
  }
  // Re-verify before the hard kill: never SIGKILL a PID that was reused.
  if (checkOwnership(file, on).kind === "ours") {
    signal(pid, "SIGKILL");
    for (let i = 0; i < 40 && checkOwnership(file, on).kind === "ours"; i++) await sleep(50);
  }
  clearRecord(file);
  return { stopped: true, pid };
}
