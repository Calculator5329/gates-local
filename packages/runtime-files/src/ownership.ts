import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isIPv4, isIPv6 } from "node:net";
import { endianness } from "node:os";
import path from "node:path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * What the app records about a process it started: its PID, kernel start
 * time and command line. `modelsDir` is the OLLAMA_MODELS given to it, and
 * `holdsOne` says it was started with OLLAMA_MAX_LOADED_MODELS=1, so a
 * restart that adopts the process still knows both. Older records have neither.
 */
export const OwnedRecord = Schema.Struct({
  pid: Schema.Number,
  startTime: Schema.String,
  command: Schema.String,
  baseUrl: Schema.String,
  binary: Schema.String,
  startedAt: Schema.Number,
  modelsDir: Schema.optional(Schema.String),
  holdsOne: Schema.optional(Schema.Boolean),
});
export type OwnedRecord = typeof OwnedRecord.Type;

export type ProcIdentity = { pid: number; startTime: string; command: string; state: string };

/** Runs a command synchronously and returns stdout; throws on a non-zero exit. */
export type SyncRunner = (file: string, args: readonly string[]) => string;

const runSync: SyncRunner = (file, args) => execFileSync(file, [...args], { encoding: "utf8", windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });

/** The platform and command runner to use in place of this machine's, so a test on Linux runs the Windows path. */
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
    // external: PowerShell versions print CreationDate as different JSON, so it is compared as text.
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
    // external: /proc/<pid>/stat holds the command in field 2 with its spaces and parentheses,
    // so fields are counted from the last ")": the state is next, and starttime (field 22) is 19 on.
    const afterCommand = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const state = afterCommand[0] ?? "";
    const startTime = afterCommand[19];
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

/**
 * Linux only. `pids` narrows the search to those processes' fds (the
 * recorded or spawned pid) in place of every /proc/<pid>. `host` is the
 * probed address, an IP literal, default 127.0.0.1: a listener counts only
 * on it or on a wildcard.
 */
export interface ListenerOptions extends ProcPlatform {
  readonly pids?: readonly number[];
  readonly host?: string;
  readonly fs?: ListenerFs;
}

function procAddressBytes(localAddressHex: string): number[] | undefined {
  if (!/^[0-9A-Fa-f]+$/.test(localAddressHex) || (localAddressHex.length !== 8 && localAddressHex.length !== 32)) return undefined;
  const bytes: number[] = [];
  for (let w = 0; w < localAddressHex.length; w += 8) {
    const word = [0, 2, 4, 6].map((i) => Number.parseInt(localAddressHex.slice(w + i, w + i + 2), 16));
    // external: /proc/net/tcp prints an address as 32-bit words in host byte order.
    bytes.push(...(endianness() === "LE" ? word.toReversed() : word));
  }
  return bytes;
}

function ipLiteralBytes(host: string): { family: 4 | 6; bytes: number[] } | undefined {
  const bare = host.replace(/^\[(.*)\]$/, "$1");
  if (isIPv4(bare)) return { family: 4, bytes: bare.split(".").map(Number) };
  if (!isIPv6(bare) || bare.includes("%")) return undefined;
  // external: Node's URL parser prints an IPv6 host compressed, with an IPv4 tail as hex groups.
  const groups = new URL(`http://[${bare}]/`).hostname.slice(1, -1).split(":");
  const gap = groups.indexOf("");
  const full = gap === -1 ? groups : [...groups.slice(0, gap), ...Array.from({ length: 8 - groups.filter(Boolean).length }, () => "0"), ...groups.slice(gap).filter(Boolean)];
  return { family: 6, bytes: full.flatMap((g) => [Number.parseInt(g, 16) >> 8, Number.parseInt(g, 16) & 0xff]) };
}

const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];

const isWildcard = (address: readonly number[]) => address.every((b) => b === 0);

function serves(local: number[], probed: { family: 4 | 6; bytes: number[] }): boolean {
  if (local.length === 4) return probed.family === 4 && (same(local, probed.bytes) || isWildcard(local));
  if (probed.family === 6) return same(local, probed.bytes) || isWildcard(local);
  // external: /proc does not show a socket's IPV6_V6ONLY (bindv6only is only the default), so a tcp6 [::]
  // listener may be IPv6-only and is not taken to serve IPv4; only an IPv4-mapped address is.
  return same(local.slice(0, 12), MAPPED_PREFIX) && same(local.slice(12), probed.bytes);
}

const PROC_NET_TCP_COLUMN = { localAddress: 1, state: 3, inode: 9 } as const;
const PROC_NET_TCP_LISTEN_STATE = "0A";

/**
 * Linux: the inodes of LISTEN sockets on `port` in /proc/net/tcp or
 * /proc/net/tcp6 text; with `host`, only those bound to it or a wildcard.
 */
export function listenInodes(text: string, port: number, host?: string): string[] {
  const probed = host === undefined ? undefined : ipLiteralBytes(host);
  if (host !== undefined && probed === undefined) return [];
  const inodes: string[] = [];
  for (const line of text.split("\n").slice(1)) {
    const columns = line.trim().split(/\s+/);
    const local = columns[PROC_NET_TCP_COLUMN.localAddress];
    if (columns.length < 10 || local === undefined || columns[PROC_NET_TCP_COLUMN.state] !== PROC_NET_TCP_LISTEN_STATE) continue;
    const inode = columns[PROC_NET_TCP_COLUMN.inode];
    if (inode === undefined || inode === "0") continue;
    const colon = local.lastIndexOf(":");
    if (Number.parseInt(local.slice(colon + 1), 16) !== port) continue;
    if (probed !== undefined) {
      const bytes = procAddressBytes(local.slice(0, colon));
      if (bytes === undefined || !serves(bytes, probed)) continue;
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
  const inodes = new Set<string>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try {
      text = fs.readFile(file);
    } catch {
      continue;
    }
    for (const inode of listenInodes(text, port, host)) inodes.add(inode);
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
 * undefined (never "ours"). A recorded process that is alive may have let
 * go of its port, and another Ollama taken it: this names who holds it now.
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
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const r = Schema.decodeUnknownResult(OwnedRecord)(json);
  return Result.isSuccess(r) ? r.success : undefined;
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

/** `ours` only while the recorded PID is alive with the recorded start time and command line. */
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

/** `adopted`: on Windows, ours from an earlier run, with no handle to stop it through; left running. */
export type StopResult =
  | { stopped: true; pid: number }
  | { stopped: false; reason: "no-record" | "gone" }
  | { stopped: false; reason: "adopted" }
  | { stopped: false; reason: "not-ours"; detail: string };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    // external: POSIX takes a negative PID as the whole process group, so Ollama's runners go with it.
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      // why: a process that is already gone needs no signal.
      return;
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
  const stillOurs = () => checkOwnership(file, on).kind === "ours";
  signal(pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!stillOurs()) break;
    await sleep(50);
  }
  // why: checked again before the hard kill, as the PID may have been reused by then.
  if (stillOurs()) {
    signal(pid, "SIGKILL");
    for (let i = 0; i < 40 && stillOurs(); i++) await sleep(50);
  }
  clearRecord(file);
  return { stopped: true, pid };
}
