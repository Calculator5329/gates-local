// The running app's pid file, so the updater can tell the app is open. On
// Windows a running app holds electron.exe and an install would stop half
// way; on Linux an update under a running app leaves it on the old code.
//
// Main writes <data dir>/desktop.pid.json once it holds the single-instance
// lock and removes it on exit. A file left by a crash names a pid that is no
// longer alive, which reads as not running.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const RUNNING_FILE = "desktop.pid.json";

export function runningFile(dataDir: string): string {
  return path.join(dataDir, RUNNING_FILE);
}

export function writeRunning(dataDir: string, pid: number, now: number): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(runningFile(dataDir), `${JSON.stringify({ pid, startedAt: now })}\n`);
}

/** Removes the file only when it still names this pid (a newer launch may have written its own). */
export function clearRunning(dataDir: string, pid: number): void {
  try {
    const text = readFileSync(runningFile(dataDir), "utf8");
    if ((JSON.parse(text) as { pid?: unknown }).pid === pid) rmSync(runningFile(dataDir), { force: true });
  } catch {
    // Nothing to clear.
  }
}

/** The running app's pid, or null when no file names a live process. */
export function readRunning(dataDir: string, alive: (pid: number) => boolean): { pid: number; file: string } | null {
  const file = runningFile(dataDir);
  let pid: unknown;
  try {
    pid = (JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown }).pid;
  } catch {
    return null;
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  return alive(pid) ? { pid, file } : null;
}
