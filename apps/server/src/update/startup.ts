// Durable handoff from the detached updater to the app's first ready server.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clearTransaction, readTransaction } from "./transaction.ts";
import { readHeadCommit } from "./version.ts";
import { writeRecord } from "./record.ts";
import { isAlive } from "./wait.ts";
import type { RunResult } from "./run.ts";

export const STARTUP_TOKEN_ENV = "GATES_LOCAL_UPDATE_STARTUP_TOKEN";
export const STARTUP_ACK_FILE = "update-startup.json";
export type StartupAck = { readonly token: string; readonly commit: string; readonly state: "ready" | "failed"; readonly reason?: string };

export interface StartupProcess {
  readonly pid: number;
  /** Ends only this app's owned process tree and confirms it has ended. */
  stop(): Promise<boolean>;
}

export async function waitForStartup(options: { root: string; dataDir: string; token: string; commit: string; app: StartupProcess; timeoutMs?: number; alive?: (pid: number) => boolean }): Promise<RunResult> {
  const alive = options.alive ?? isAlive;
  const deadline = performance.now() + (options.timeoutMs ?? 60_000);
  let reason = "The new version timed out before its server became ready.";
  while (performance.now() < deadline) {
    const ack = readStartupAck(options.dataDir, options.token, options.commit);
    if (ack?.state === "ready" && readTransaction(options.root) === null && alive(options.app.pid)) return { code: 0, stdout: "Server ready", stderr: "" };
    if (ack?.state === "failed") { reason = ack.reason ?? "The new version failed during initialization."; break; }
    if (!alive(options.app.pid)) { reason = "The new version exited before its server became ready."; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const stopped = await options.app.stop();
  return { code: 1, stdout: "", stderr: reason, ...(stopped ? {} : { treeStillRunning: true }) };
}

function writeAck(dataDir: string, ack: StartupAck): void {
  const file = path.join(dataDir, STARTUP_ACK_FILE);
  const pending = `${file}.${process.pid}.pending`;
  writeFileSync(pending, JSON.stringify(ack), { mode: 0o600 });
  renameSync(pending, file);
}

export function readStartupAck(dataDir: string, token: string, commit: string): StartupAck | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path.join(dataDir, STARTUP_ACK_FILE), "utf8"));
    if (typeof value !== "object" || value === null || !("token" in value) || value.token !== token || !("commit" in value) || value.commit !== commit || !("state" in value) || (value.state !== "ready" && value.state !== "failed")) return undefined;
    return { token, commit, state: value.state, ...("reason" in value && typeof value.reason === "string" ? { reason: value.reason } : {}) };
  } catch { return undefined; }
}

/** Called only after the desktop supervisor reports a ready server. */
export function acknowledgeStartup(root: string, dataDir: string, token?: string): boolean {
  const transaction = readTransaction(root);
  if (transaction?.phase !== "launch" || transaction.startupToken !== token || readHeadCommit(root) !== transaction.to.commit) return false;
  writeRecord(dataDir, { at: Date.now(), outcome: "updated", channel: transaction.channel, from: transaction.from, to: transaction.to, changes: transaction.changes });
  if (token !== undefined) writeAck(dataDir, { token, commit: transaction.to.commit, state: "ready" });
  clearTransaction(root);
  return true;
}

/** An initialization failure leaves the transaction intact for the updater's rollback. */
export function reportStartupFailure(root: string, dataDir: string, token: string | undefined, reason: string): void {
  const transaction = readTransaction(root);
  if (token === undefined || transaction?.phase !== "launch" || transaction.startupToken !== token || readHeadCommit(root) !== transaction.to.commit) return;
  writeAck(dataDir, { token, commit: transaction.to.commit, state: "failed", reason });
}
