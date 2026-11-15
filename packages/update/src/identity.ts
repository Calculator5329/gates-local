// Telling a process from a later one that was given the same number.
//
// A process id alone says nothing once the process is gone: the system hands
// the number out again. The start time, where the platform gives it, tells
// them apart. Node built-ins only, like everything the updater imports.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { uptime } from "node:os";
import { groupExists } from "./run.ts";
import { isAlive } from "./wait.ts";

/** Runs a command and returns what it printed; throws when it fails. */
export type Exec = (command: string, args: readonly string[]) => string;

const exec: Exec = (command, args) =>
  execFileSync(command, [...args], { encoding: "utf8", timeout: 5_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } }).trim();

/** Field 22 of a /proc stat line, the start time. The process name is in brackets and can hold spaces and brackets, so this counts from after the last one. */
export const startTicks = (stat: string): string | undefined => stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];

/** Clock ticks since boot, with the boot's id: the ticks alone repeat after a restart. */
function linuxStart(pid: number): string | null {
  try {
    const ticks = startTicks(readFileSync(`/proc/${pid}/stat`, "utf8"));
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return ticks === undefined ? null : `${boot}:${ticks}`;
  } catch {
    return null;
  }
}

/**
 * When this process started, as text only ever compared for equality. Null
 * when the process is gone or the platform will not say; then the id is all
 * there is, and a live id counts as the same process.
 */
export function startOf(pid: number, platform: NodeJS.Platform = process.platform, run: Exec = exec): string | null {
  if (platform === "linux") return linuxStart(pid);
  try {
    const text = platform === "win32"
      ? run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`])
      : run("ps", ["-o", "lstart=", "-p", String(pid)]);
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

/** Windows FILETIME text stays exact in JSON; unusable evidence proves nothing. */
export const isWindowsBootTime = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d{0,19}$/.test(value);

export function windowsBootTime(run: Exec = exec): string | null {
  try {
    const value = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToFileTimeUtc()"]).trim();
    return isWindowsBootTime(value) ? value : null;
  } catch { return null; }
}

/** A command the updater started, as saved in the transaction. */
export interface ProcessRecord {
  readonly pid: number;
  readonly start: string | null;
  /** The computer's uptime when this was saved. It only ever goes down across a restart. */
  readonly uptime: number;
  /** LastBootUpTime as UTC FILETIME. Absent on older records or an unreadable lookup. */
  readonly boot?: string;
}

export function processRecord(pid: number, o: TreeCheck = {}): ProcessRecord {
  const platform = o.platform ?? process.platform;
  const boot = platform === "win32" ? (o.bootTime ?? windowsBootTime)() : null;
  return { pid, start: o.startOf ? o.startOf(pid) : startOf(pid, platform), uptime: (o.uptime ?? uptime)(), ...(isWindowsBootTime(boot) ? { boot } : {}) };
}

/** Capture boot evidence before spawning children, once per updater/launcher. */
export function createProcessRecorder(o: TreeCheck = {}): (pid: number) => ProcessRecord {
  const platform = o.platform ?? process.platform;
  const boot = platform === "win32" ? (o.bootTime ?? windowsBootTime)() : null;
  return pid => processRecord(pid, { ...o, platform, bootTime: () => boot });
}

export interface TreeCheck {
  readonly platform?: NodeJS.Platform;
  readonly exists?: (pid: number) => boolean;
  readonly startOf?: (pid: number) => string | null;
  readonly uptime?: () => number;
  readonly bootTime?: () => string | null;
  /** A saved desktop launch may retain helpers after its Windows root disappears. */
  readonly requireWholeWindowsTree?: boolean;
}

/**
 * Whether a saved command and everything it started have ended. POSIX asks
 * after the whole process group, which lasts as long as any member does.
 * Windows can only ask after the root process.
 */
export function treeGone(r: ProcessRecord, o: TreeCheck = {}): boolean {
  if ((o.uptime ?? uptime)() < r.uptime) return true;
  const platform = o.platform ?? process.platform;
  if (platform === "win32" && isWindowsBootTime(r.boot)) {
    const current = (o.bootTime ?? windowsBootTime)();
    if (isWindowsBootTime(current) && BigInt(current) > BigInt(r.boot)) return true;
  }
  // A later updater has no owned taskkill acknowledgement or job handle.
  // Until boot evidence or uptime proves a restart, neither root absence nor PID reuse can
  // certify a saved Windows desktop launch's descendants have stopped.
  if (o.requireWholeWindowsTree === true && platform === "win32") return false;
  const exists = o.exists ?? (platform === "win32" ? isAlive : groupExists);
  if (!exists(r.pid)) return true;
  // A number still in use as a group is never handed out again, so a different process there means the group ended.
  const now = r.start === null ? null : (o.startOf ?? startOf)(r.pid);
  return now !== null && now !== r.start;
}
