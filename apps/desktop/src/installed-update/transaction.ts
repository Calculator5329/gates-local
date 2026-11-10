// The installed update's write-ahead record: <data dir>/updates/installed-update.json.
//
// Every row of the design's Linux table (docs/design/installed-updates.md,
// section 2) writes its intent here before it acts, and recovery reads it
// back. `writeIntent` is the only writer: file write, file flush, rename into
// place, then a flush of the folder, so a reader sees the old intent or the
// new one and never half a file. Only the watcher calls it after row H.
//
// The fields are checked by hand. The repo decodes files it reads back with
// Effect Schema, but the desktop package has no `effect` dependency, and
// adding one is outside this folder (see the lane report). The clone
// updater's own transaction is checked by hand for a similar reason.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { HANDOFF_GRACE_MS } from "../../../server/src/update/admission.ts";
import type { ProcessRecord } from "../../../server/src/update/identity.ts";
import { validateReleaseVersion, type ReleaseArtifact } from "../../../server/src/update/release-manifest.ts";
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

/** A token launch (T1 of row L1, T2 of row B4). */
export interface TokenLaunch {
  readonly token: string;
  /** The boot id when the intent naming this token was written: a later boot means it cannot be running. */
  readonly boot: string;
  /** Saved after the spawn. Absent: not spawned yet, or the watcher died before saving it. */
  readonly record?: ProcessRecord;
  /** The spawn returned an error, so this launch never ran. */
  readonly spawnFailed?: true;
}

/** How a transaction that reached row C ended, so a cleanup retry knows. */
export type Ending = "updated" | "rolled-back" | "stopped";

export interface InstalledTransaction {
  readonly version: 1;
  readonly id: string;
  /** Real paths of the program file and the data folder: what "this copy" means. */
  readonly copy: { readonly program: string; readonly dataDir: string };
  readonly from: string;
  readonly to: string;
  /** SHA-512 of the approved release list's exact bytes. */
  readonly listDigest: string;
  readonly artifact: ReleaseArtifact;
  /** Row H's approval deadline: uptime in seconds, valid only on this boot. */
  readonly deadline: { readonly uptime: number; readonly boot: string };
  /** The old main and its supervised server, saved at row H. */
  readonly processes: { readonly main: ProcessRecord; readonly server: ProcessRecord };
  readonly intent: Intent;
  /** Row W2: what was at the program path, the pinned artifact, and the store's user_version. */
  readonly old?: Identity;
  readonly new?: Identity;
  readonly storeBefore?: number;
  readonly t1?: TokenLaunch;
  readonly t2?: TokenLaunch;
  readonly ending?: Ending;
}

export interface Approval {
  readonly id?: string;
  readonly copy: InstalledTransaction["copy"];
  readonly from: string;
  readonly to: string;
  readonly listDigest: string;
  readonly artifact: ReleaseArtifact;
  /** os.uptime() and the boot id when the person's approval was committed. */
  readonly uptime: number;
  readonly boot: string;
  readonly main: ProcessRecord;
  readonly server: ProcessRecord;
}

/** Row H's transaction: the intent `approved`, with the deadline the clone uses (uptime + the handoff grace). */
export function approve(a: Approval): InstalledTransaction {
  return {
    version: 1, id: a.id ?? randomUUID(), copy: a.copy, from: a.from, to: a.to, listDigest: a.listDigest, artifact: a.artifact,
    deadline: { uptime: a.uptime + HANDOFF_GRACE_MS / 1000, boot: a.boot },
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
  // A saved record means the spawn succeeded; one with both is not a file the watcher wrote.
  if (record !== undefined && v["spawnFailed"] !== undefined) return null;
  return { token: v["token"], boot: v["boot"], ...(record === undefined ? {} : { record }), ...(v["spawnFailed"] === true ? { spawnFailed: true } : {}) };
}

/** Which later fields each intent needs. */
const NEEDS_IDENTITIES: ReadonlySet<Intent> = new Set(["identified", "stage", "keep-previous", "replace", "launch-new", "accepted", "stop-new", "restore-aside", "restore-install", "put-back", "launch-old", "went-back"]);
const NEEDS_T1: ReadonlySet<Intent> = new Set(["launch-new", "accepted", "stop-new", "restore-aside", "restore-install", "put-back", "launch-old", "went-back"]);
const NEEDS_T2: ReadonlySet<Intent> = new Set(["launch-old", "went-back"]);

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
  // The id and `to` name files and folders (`.previous-<id>`, `updates/<to>`): both must stay inside them.
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
