import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

// external: on Windows a running app holds electron.exe, so an install under it stops half way.
export const RUNNING_FILE = "desktop.pid.json";

export function runningFile(dataDir: string): string {
  return path.join(dataDir, RUNNING_FILE);
}

export function writeRunning(dataDir: string, pid: number, now: number): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(runningFile(dataDir), `${JSON.stringify({ pid, startedAt: now })}\n`);
}

export function clearRunning(dataDir: string, pid: number): void {
  try {
    const text = readFileSync(runningFile(dataDir), "utf8");
    if ((JSON.parse(text) as { pid?: unknown }).pid === pid) rmSync(runningFile(dataDir), { force: true });
  } catch {}
}

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
