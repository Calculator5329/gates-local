// The token launch's "my server is ready" (rows L2 and B4 of
// docs/design/installed-updates.md, section 2): the token-matched ack pattern
// of the clone's update-startup.json (apps/server/src/update/startup.ts), in
// this copy's updates/ folder, now flushed (file, then folder) before the
// rename counts. The ack is a request, not a decision: the watcher decides.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import path from "node:path";
import type { ProcessRecord } from "../../../server/src/update/identity.ts";
import { UPDATES_FOLDER } from "./transaction.ts";
import type { Ack } from "./watch.ts";

export const ACK_NAME = "update-startup.json";
const POLL_MS = 100;

export const ackFile = (dataDir: string): string => path.join(dataDir, UPDATES_FOLDER, ACK_NAME);

function flushFolder(dir: string): void {
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Written by a token launch once its supervisor says the server is ready. Returns once it is on disk. */
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

/** Whether the ack on disk is this token's. Anything else (none, another token, a torn or foreign file) is not. */
export function readAck(dataDir: string, token: string): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(ackFile(dataDir), "utf8"));
    return typeof value === "object" && value !== null && "token" in value && value.token === token && "state" in value && value.state === "ready";
  } catch {
    return false;
  }
}

export interface AckWait {
  readonly dataDir: string;
  readonly token: string;
  readonly record: ProcessRecord;
  readonly timeoutMs: number;
  /** Whether the launch's tree has ended. */
  readonly treeGone: (record: ProcessRecord) => boolean;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Waits for this token's ack, timed with performance.now(). The ack is looked
 * for before the launch's tree, so an ack written just before an exit still
 * counts as ready: what happens after that is an ordinary crash of a version
 * that started.
 */
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
