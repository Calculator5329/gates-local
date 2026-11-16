import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import path from "node:path";
import { brokenForTest } from "@gates-local/update/break-for-test";
import type { ProcessRecord } from "@gates-local/update/identity";
import { UPDATES_FOLDER } from "@gates-local/update/installed/transaction";
import type { Ack } from "./watch.ts";

export const ACK_NAME = "update-startup.json";
const POLL_MS = 100;

export const ackFile = (dataDir: string): string => path.join(dataDir, UPDATES_FOLDER, ACK_NAME);

function flushFolder(dir: string): void {
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function writeAck(dataDir: string, token: string): void {
  const file = ackFile(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify({ token, state: "ready" })}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  flushFolder(path.dirname(file));
}

export function readAck(dataDir: string, token: string): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(ackFile(dataDir), "utf8"));
    return typeof value === "object" && value !== null && "token" in value && (value.token === token || brokenForTest("any-ready-note-counts")) && "state" in value && value.state === "ready";
  } catch {
    return false;
  }
}

export interface AckWait {
  readonly dataDir: string;
  readonly token: string;
  readonly record: ProcessRecord;
  readonly timeoutMs: number;
  readonly treeGone: (record: ProcessRecord) => boolean;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export async function waitForAck(o: AckWait): Promise<Ack> {
  const now = o.now ?? (() => performance.now());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const until = now() + o.timeoutMs;
  for (;;) {
    if (readAck(o.dataDir, o.token)) return "ready";
    if (o.treeGone(o.record)) return readAck(o.dataDir, o.token) ? "ready" : "exited";
    if (now() >= until) return "timeout";
    await sleep(POLL_MS);
  }
}
