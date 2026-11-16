import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ProcessRecord } from "../identity.ts";
import { validateReleaseVersion, type ReleaseArtifact } from "../release-manifest.ts";
import { ioCode, realFileOps, type FileOps, type Identity } from "./files.ts";

export const UPDATES_FOLDER = "updates";
export const TRANSACTION_NAME = "installed-update.json";
export const LOCK_NAME = "update.lock";

export const transactionFile = (dataDir: string): string => path.join(dataDir, UPDATES_FOLDER, TRANSACTION_NAME);
export const updateLockFile = (dataDir: string): string => path.join(dataDir, UPDATES_FOLDER, LOCK_NAME);

/** The rows' intents, in the order the forward path and the go-back path write them. */
export const INTENTS = [
  "approved", "identified", "stage", "keep-previous", "replace", "launch-new", "accepted",
  "stop-new", "restore-aside", "restore-install", "put-back", "launch-old", "went-back", "cleanup",
] as const;
export type Intent = (typeof INTENTS)[number];

/**
 * A token launch (T1 of row L1, T2 of row B4). `boot` is the boot id when the
 * intent naming the token was written: a later boot means it cannot be running.
 * `record` is saved after the spawn; without it the launch was not spawned yet,
 * or the watcher died before saving it.
 */
export interface TokenLaunch {
  readonly token: string;
  readonly boot: string;
  readonly record?: ProcessRecord;
  readonly spawnFailed?: true;
}

/** How a transaction that reached row C ended, so a cleanup retry knows. */
export type Ending = "updated" | "rolled-back" | "stopped";

/**
 * The record in <data dir>/updates/installed-update.json.
 * - `copy`: real paths of the program file and the data folder, what "this copy" means.
 * - `listDigest`: SHA-512 of the approved release list's exact bytes.
 * - `deadline`: row H's approval deadline, uptime in seconds, valid only on this boot.
 * - `processes`: the old main and its supervised server, saved at row H.
 * - `old`, `new`, `storeBefore`: row W2's look at the program path, the pinned
 *   artifact and the store's user_version.
 */
export interface InstalledTransaction {
  readonly version: 1;
  readonly id: string;
  readonly copy: { readonly program: string; readonly dataDir: string };
  readonly from: string;
  readonly to: string;
  readonly listDigest: string;
  readonly artifact: ReleaseArtifact;
  readonly deadline: { readonly uptime: number; readonly boot: string };
  readonly processes: { readonly main: ProcessRecord; readonly server: ProcessRecord };
  readonly intent: Intent;
  readonly old?: Identity;
  readonly new?: Identity;
  readonly storeBefore?: number;
  readonly t1?: TokenLaunch;
  readonly t2?: TokenLaunch;
  readonly ending?: Ending;
}

/** `uptime` and `boot` are os.uptime() and the boot id when the person's approval was committed. */
export interface Approval {
  readonly id?: string;
  readonly copy: InstalledTransaction["copy"];
  readonly from: string;
  readonly to: string;
  readonly listDigest: string;
  readonly artifact: ReleaseArtifact;
  readonly uptime: number;
  readonly boot: string;
  readonly main: ProcessRecord;
  readonly server: ProcessRecord;
}

/**
 * How long after the approval W1 may still start the update: the old app's
 * close, the watcher's own start from the AppImage and its first reads all
 * fall inside it. The clone updater keeps its own 5 s grace (admission.ts).
 *
 * The server reads this same number: after main lets go it keeps new work out
 * for this long (apps/server/src/update/installed/module.ts), and main counts
 * the deadline from before the server committed, so the server never takes
 * work again while W1 may still start.
 */
export const INSTALLED_APPROVAL_MS = 30_000;

/** Row H's transaction: the intent `approved`, with the deadline uptime + INSTALLED_APPROVAL_MS on this boot. */
export function approve(a: Approval): InstalledTransaction {
  return {
    version: 1, id: a.id ?? randomUUID(), copy: a.copy, from: a.from, to: a.to, listDigest: a.listDigest, artifact: a.artifact,
    deadline: { uptime: a.uptime + INSTALLED_APPROVAL_MS / 1000, boot: a.boot },
    processes: { main: a.main, server: a.server }, intent: "approved",
  };
}

/** The one writer. Returns only once the intent is on disk; throws when it is not, and then the previous intent is still whole. */
export function writeIntent(file: string, tx: InstalledTransaction, ops: FileOps = realFileOps): void {
  const tmp = `${file}.tmp`;
  ops.writeFile(tmp, `${JSON.stringify(tx, null, 2)}\n`, 0o600);
  ops.rename(tmp, file);
  ops.fsyncDir(path.dirname(file));
}

/** Ends the transaction: removes the file and flushes its folder. */
export function removeTransaction(file: string, ops: FileOps = realFileOps): void {
  try {
    ops.unlink(file);
  } catch (e) {
    if (ioCode(e) !== "ENOENT") throw e;
  }
  ops.fsyncDir(path.dirname(file));
}

/** A transaction file that is there but cannot be acted on. Nothing guesses at what it meant. */
export class UnreadableTransaction extends Error {
  readonly file: string;
  constructor(file: string, why: string) {
    super(`${file}: ${why}`);
    this.name = "UnreadableTransaction";
    this.file = file;
  }
}

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v !== "";
const isName = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9-]{1,64}$/.test(v);
function isVersion(v: unknown): v is string {
  try {
    validateReleaseVersion(v);
    return true;
  } catch {
    return false;
  }
}
const isHex128 = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{128}$/.test(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isIntent = (v: unknown): v is Intent => typeof v === "string" && (INTENTS as readonly string[]).includes(v);
const ENDINGS: readonly string[] = ["updated", "rolled-back", "stopped"];
const isEnding = (v: unknown): v is Ending => typeof v === "string" && ENDINGS.includes(v);

function processRecord(v: unknown): ProcessRecord | null {
  if (!isRow(v)) return null;
  const { pid, start, uptime } = v;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || !(start === null || isText(start)) || typeof uptime !== "number" || !Number.isFinite(uptime)) return null;
  return { pid, start, uptime };
}

function identity(v: unknown): Identity | null {
  return isRow(v) && isCount(v["size"]) && isHex128(v["sha512"]) ? { size: v["size"], sha512: v["sha512"] } : null;
}

function artifact(v: unknown): ReleaseArtifact | null {
  if (!isRow(v)) return null;
  const { platform, arch, kind, file, size, sha512 } = v;
  if (platform !== "linux" || arch !== "x64" || kind !== "appimage" || !isText(file) || path.basename(file) !== file || !isCount(size) || !isHex128(sha512)) return null;
  return { platform, arch, kind, file, size, sha512 };
}

function tokenLaunch(v: unknown): TokenLaunch | null {
  if (!isRow(v) || !isText(v["token"]) || !isText(v["boot"])) return null;
  const record = v["record"] === undefined ? undefined : processRecord(v["record"]);
  if (record === null) return null;
  if (v["spawnFailed"] !== undefined && v["spawnFailed"] !== true) return null;
  if (record !== undefined && v["spawnFailed"] !== undefined) return null;
  return { token: v["token"], boot: v["boot"], ...(record === undefined ? {} : { record }), ...(v["spawnFailed"] === true ? { spawnFailed: true } : {}) };
}

const NEEDS_IDENTITIES: ReadonlySet<Intent> = new Set(["identified", "stage", "keep-previous", "replace", "launch-new", "accepted", "stop-new", "restore-aside", "restore-install", "put-back", "launch-old", "went-back"]);
const NEEDS_T1: ReadonlySet<Intent> = new Set(["launch-new", "accepted", "stop-new", "restore-aside", "restore-install", "put-back", "launch-old", "went-back"]);
const NEEDS_T2: ReadonlySet<Intent> = new Set(["launch-old", "went-back"]);

// why: the desktop package has no effect dependency, so the fields are checked by hand.
function decode(file: string, text: string): InstalledTransaction {
  const fail = (why: string): never => { throw new UnreadableTransaction(file, why); };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return fail("not JSON");
  }
  if (!isRow(v) || v["version"] !== 1) return fail("not a version 1 transaction");
  const { id, copy, from, to, listDigest, deadline, processes, intent } = v;
  if (!isName(id) || !isVersion(from) || !isVersion(to) || !isHex128(listDigest)) return fail("id, versions or list digest");
  if (!isRow(copy) || !isText(copy["program"]) || !isText(copy["dataDir"])) return fail("copy");
  const pinned = artifact(v["artifact"]) ?? fail("artifact");
  if (!isRow(deadline) || typeof deadline["uptime"] !== "number" || !isText(deadline["boot"])) return fail("deadline");
  if (!isRow(processes)) return fail("process records");
  const main = processRecord(processes["main"]) ?? fail("main process record");
  const server = processRecord(processes["server"]) ?? fail("server process record");
  if (!isIntent(intent)) return fail("intent");
  const tx: { -readonly [K in keyof InstalledTransaction]: InstalledTransaction[K] } = {
    version: 1, id, copy: { program: copy["program"], dataDir: copy["dataDir"] }, from, to, listDigest, artifact: pinned,
    deadline: { uptime: deadline["uptime"], boot: deadline["boot"] }, processes: { main, server }, intent,
  };
  if (v["old"] !== undefined) tx.old = identity(v["old"]) ?? fail("old");
  if (v["new"] !== undefined) tx.new = identity(v["new"]) ?? fail("new");
  if (v["storeBefore"] !== undefined) tx.storeBefore = isCount(v["storeBefore"]) ? v["storeBefore"] : fail("storeBefore");
  if (v["t1"] !== undefined) tx.t1 = tokenLaunch(v["t1"]) ?? fail("t1");
  if (v["t2"] !== undefined) tx.t2 = tokenLaunch(v["t2"]) ?? fail("t2");
  if (v["ending"] !== undefined) tx.ending = isEnding(v["ending"]) ? v["ending"] : fail("ending");
  if (NEEDS_IDENTITIES.has(intent) && (tx.old === undefined || tx.new === undefined || tx.storeBefore === undefined)) fail(`${intent} without old, new and storeBefore`);
  if (NEEDS_T1.has(intent) && tx.t1 === undefined) fail(`${intent} without T1`);
  if (NEEDS_T2.has(intent) && tx.t2 === undefined) fail(`${intent} without T2`);
  if (intent === "cleanup" && tx.ending === undefined) fail("cleanup without its ending");
  return tx;
}

/** The unfinished transaction, or null when there is none. Throws UnreadableTransaction for a file that is there and does not decode. */
export function readTransaction(file: string): InstalledTransaction | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (ioCode(e) === "ENOENT") return null;
    throw e;
  }
  return decode(file, text);
}
