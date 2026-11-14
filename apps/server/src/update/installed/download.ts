// Download a newer version for this copy into <data dir>/updates/<version>/
// and prove it is the file the signed release list names. Nothing here
// installs, runs or moves the file into place: the next step reads the folder
// through verifyPrepared, the only door to "ready".
//
// The folder's contract, in the order it is written:
//   1. release.json and release.json.sig, the exact bytes the check verified;
//   2. <file>.part, streamed from B/download/v<version>/<file>, counted and
//      hashed as it arrives, stopped the moment it passes the listed size;
//   3. <file>, renamed from .part only after its size and SHA-512 matched and
//      it was flushed.
// A folder without the list or signature, or holding a .part, is incomplete
// and deleted; nothing is resumed. A complete folder is still checked again
// (signature against the built-in keys, version above the running one, the
// artifact's hash) before anything calls it ready, and deleted if it fails.
// Nothing outside <data dir>/updates/ is ever deleted: every recursive delete
// resolves its version folder first and refuses a name that is not
// major.minor.patch. That holds by path. If the person made updates/ itself a
// link, the deletes follow it to wherever it points; a version folder or an
// artifact that is a link is never trusted, and deleting one removes only
// the link.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type ReleaseArtifact, type ReleaseManifest, validateReleaseVersion, verifyManifest } from "../release-manifest.ts";
import { compare, parseRelease } from "../semver.ts";
import type { Body, Stream, Streamed } from "./feed.ts";

export const UPDATES_FOLDER = "updates";
export const LIST_FILE = "release.json";
export const SIGNATURE_FILE = "release.json.sig";
const PART = ".part";

/**
 * The artifact has no total time limit; a server that answers just inside the
 * idle timeout (one byte every 29 seconds) would otherwise hold a download
 * open for years. Less than this many bytes in each successive window ends
 * it. The windows follow one another, each starting at the chunk that closed
 * the last, so a server can stay just under the rate across a boundary: the
 * real floor is about half of it.
 */
export const SLOWEST = { windowMs: 300_000, bytes: 256 * 1024 } as const;
/** Windows only: how long a refused final rename is tried again. */
export const RENAME_RETRY_MS = 2_000;
const RENAME_WAIT_MS = 100;
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Who is asking: which keys, which running version, which platform's file. */
export interface Identity {
  readonly dataDir: string;
  /** The running copy's version: a prepared version must be above it. */
  readonly running: string;
  readonly keys: readonly string[];
  readonly platform: string;
  readonly arch: string;
}

/** A folder verifyPrepared has just checked from its bytes on disk. */
export interface PreparedRelease {
  readonly version: string;
  readonly folder: string;
  /** The artifact's absolute path. */
  readonly file: string;
  readonly artifact: ReleaseArtifact;
  readonly manifest: ReleaseManifest;
  /** SHA-512 of the stored list's exact bytes: the approval pin (design section 5). */
  readonly listSha512: string;
}

export type Verified = { readonly ok: true; readonly prepared: PreparedRelease } | { readonly ok: false; readonly reason: string };

export type DownloadOutcome =
  | { readonly kind: "ready"; readonly prepared: PreparedRelease; readonly fetched: boolean }
  /** The bytes did not match the signed list (size or hash); received is how many were taken. */
  | { readonly kind: "bad-download"; readonly detail: string; readonly received: number }
  | { readonly kind: "could-not-download"; readonly detail: string }
  | { readonly kind: "disk"; readonly volume: string; readonly needed: number; readonly free: number }
  | { readonly kind: "cancelled" };

export interface Space {
  /** The mount point (Linux) or drive (Windows) the folder is on. */
  readonly volume: string;
  readonly free: number;
}

export interface DownloadOptions extends Identity {
  /** The release page base B. */
  readonly base: URL;
  /** The version the check found; must be the list's own. */
  readonly version: string;
  /** The exact bytes the check fetched and verified. */
  readonly list: Buffer;
  readonly signature: Buffer;
  readonly stream: Stream;
  readonly signal: AbortSignal;
  readonly progress?: (received: number, total: number) => void;
  /** Tests pretend a full disk; the default reads the real volume. */
  readonly freeSpace?: (folder: string) => Promise<Space>;
  /** Tests shorten it; the default is SLOWEST. */
  readonly slowest?: { readonly windowMs: number; readonly bytes: number };
  readonly now?: () => number;
}

const errorCode = (error: unknown): unknown => (typeof error === "object" && error !== null && "code" in error ? error.code : undefined);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function updatesRoot(dataDir: string): string {
  return path.resolve(dataDir, UPDATES_FOLDER);
}

/**
 * <data dir>/updates/<version>, or a throw before any file call: the name
 * must be a release version and the resolved folder a direct child of updates/.
 */
export function versionFolder(dataDir: string, version: string): string {
  try { validateReleaseVersion(version); }
  catch { throw new Error(`refused the update folder name ${JSON.stringify(version)}: it is not major.minor.patch`); }
  const root = updatesRoot(dataDir);
  const folder = path.resolve(root, version);
  if (path.dirname(folder) !== root || path.basename(folder) !== version) throw new Error(`refused the update folder name ${JSON.stringify(version)}: it is not major.minor.patch inside ${UPDATES_FOLDER}`);
  return folder;
}

/**
 * The one recursive delete: a version folder, its path checked first. On
 * Windows a scanner may hold a fresh file for a moment; the retries keep that
 * from turning "did not match" into "could not download".
 */
async function removeVersion(dataDir: string, version: string): Promise<void> {
  const folder = versionFolder(dataDir, version);
  await fs.promises.rm(folder, { recursive: true, force: true, maxRetries: 3 });
}

/** The listed file's path in folder, or a throw when the name is not a plain name inside it. Called before any file is opened. */
export function fileIn(folder: string, name: string): string {
  const file = path.join(folder, name);
  if (path.dirname(file) !== folder || path.basename(file) !== name) throw new Error("the release list names a file outside its folder");
  return file;
}

/** SHA-512 of a signed list's exact bytes, as PreparedRelease.listSha512 holds it. */
export const listHash = (list: Buffer) => createHash("sha512").update(list).digest("hex");

/** B/download/v<version>/<file>; B never carries a query. */
export function artifactUrl(base: URL, version: string, file: string): URL {
  return new URL(`${base.href.replace(/\/+$/, "")}/download/v${encodeURIComponent(version)}/${encodeURIComponent(file)}`);
}

const artifactFor = (manifest: ReleaseManifest, o: Identity) => manifest.artifacts.find((a) => a.platform === o.platform && a.arch === o.arch);

/** The stored list's own checks, from bytes: trusted, this version, above the running one (unless kept), a file for this copy. */
function trustList(list: Buffer, signature: Buffer, version: string, o: Identity, kept = false): { manifest: ReleaseManifest; artifact: ReleaseArtifact } | string {
  let manifest: ReleaseManifest;
  try { manifest = verifyManifest(list, signature, o.keys); }
  catch (error) { return `the release list did not pass its signature check: ${message(error)}`; }
  if (manifest.version !== version) return `the release list is for version ${manifest.version}, not ${version}`;
  const listed = parseRelease(`v${manifest.version}`);
  const own = parseRelease(`v${o.running}`);
  if (listed === null || own === null) return `version ${manifest.version} or the running ${o.running} is not a release version`;
  if (!kept && compare(listed, own) <= 0) return `version ${manifest.version} is not newer than the running ${o.running}`;
  const artifact = artifactFor(manifest, o);
  if (artifact === undefined) return `the release list has no file for ${o.platform} ${o.arch}`;
  return { manifest, artifact };
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha512");
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("end", resolve).on("error", reject);
  });
  return hash.digest("hex");
}

/**
 * The only door to "ready": checks a folder again from its bytes on disk
 * (signature, version, a complete file whose size and SHA-512 match) and
 * deletes it when any check fails. The next step calls it again right before
 * it moves the file into place.
 */
export async function verifyPrepared(o: Identity & { readonly version: string }): Promise<Verified> {
  let folder: string;
  try { folder = versionFolder(o.dataDir, o.version); }
  catch (error) { return { ok: false, reason: message(error) }; }
  const reason = await check(folder, o).catch((error: unknown) => `the folder could not be read: ${message(error)}`);
  if (typeof reason !== "string") return { ok: true, prepared: reason };
  await removeVersion(o.dataDir, o.version);
  return { ok: false, reason };
}

/**
 * A kept installer (Windows, design section 3): the folder of version, at or
 * below the running one, checked from its bytes like a download. Unlike
 * verifyPrepared it never deletes: a folder that fails is only not offered.
 */
export async function verifyKept(o: Identity & { readonly version: string }): Promise<Verified> {
  let folder: string;
  try { folder = versionFolder(o.dataDir, o.version); }
  catch (error) { return { ok: false, reason: message(error) }; }
  const reason = await check(folder, o, true).catch((error: unknown) => `the folder could not be read: ${message(error)}`);
  return typeof reason === "string" ? { ok: false, reason } : { ok: true, prepared: reason };
}

async function check(folder: string, o: Identity & { readonly version: string }, kept = false): Promise<PreparedRelease | string> {
  // Links are never followed: a link's target can change after its bytes were hashed.
  if (!(await fs.promises.lstat(folder)).isDirectory()) return "the version folder is not a real folder";
  const names = await fs.promises.readdir(folder);
  if (names.some((name) => name.endsWith(PART))) return "the folder holds an unfinished download";
  if (!names.includes(LIST_FILE) || !names.includes(SIGNATURE_FILE)) return "the folder has no release list or no signature";
  const list = await fs.promises.readFile(path.join(folder, LIST_FILE));
  const signature = await fs.promises.readFile(path.join(folder, SIGNATURE_FILE));
  const trusted = trustList(list, signature, o.version, o, kept);
  if (typeof trusted === "string") return trusted;
  const { manifest, artifact } = trusted;
  const file = fileIn(folder, artifact.file);
  const stat = await fs.promises.lstat(file).catch(() => undefined);
  if (stat === undefined) return "the folder has no downloaded file";
  if (!stat.isFile()) return "the downloaded file is not a regular file";
  if (stat.size !== artifact.size || (await hashFile(file)) !== artifact.sha512) return "the downloaded file does not match the signed release list";
  return { version: o.version, folder, file, artifact, manifest, listSha512: listHash(list) };
}

/**
 * A verified folder for version holding exactly list, the signed list the
 * check has just verified, or null when there is none. A folder that fails,
 * or holds another signed list for the same version, is deleted. Never makes
 * a request.
 */
export async function preparedRelease(o: Identity & { readonly version: string; readonly list: Buffer }): Promise<Verified | null> {
  let folder: string;
  try { folder = versionFolder(o.dataDir, o.version); }
  catch (error) { return { ok: false, reason: message(error) }; }
  // lstat: a link in the folder's place is something to check (and delete), not to follow.
  const exists = await fs.promises.lstat(folder).then(() => true, () => false);
  if (!exists) return null;
  const verified = await verifyPrepared(o);
  if (!verified.ok || verified.prepared.listSha512 === listHash(o.list)) return verified;
  await removeVersion(o.dataDir, o.version);
  return { ok: false, reason: "the folder holds another signed list for this version" };
}

/** Deletes every version folder under updates/ that keep does not name. Returns the versions deleted. */
export async function removeVersions(dataDir: string, keep: readonly string[]): Promise<readonly string[]> {
  const entries = await fs.promises.readdir(updatesRoot(dataDir), { withFileTypes: true }).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  });
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || keep.includes(entry.name)) continue;
    // Only a name versionFolder accepts is ever deleted; anything else in updates/ is not ours.
    try { versionFolder(dataDir, entry.name); } catch { continue; }
    await removeVersion(dataDir, entry.name);
    removed.push(entry.name);
  }
  return removed;
}

/** The volume a folder is on: the drive on Windows, the mount point elsewhere. */
async function volumeOf(folder: string): Promise<string> {
  const resolved = path.resolve(folder);
  if (process.platform === "win32") return path.parse(resolved).root.replace(/[\\/]+$/, "");
  const device = (await fs.promises.stat(resolved)).dev;
  let current = resolved;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current || (await fs.promises.stat(parent)).dev !== device) return current;
    current = parent;
  }
}

/** Free bytes a normal user may write on the folder's volume, and its name. */
export async function freeSpace(folder: string): Promise<Space> {
  const stats = await fs.promises.statfs(folder);
  return { volume: await volumeOf(folder), free: stats.bavail * stats.bsize };
}

/** Write, flush, close: used for the list and signature. */
async function writeFlushed(file: string, bytes: Buffer): Promise<void> {
  const handle = await fs.promises.open(file, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Windows cannot open a folder to flush it; elsewhere this makes the rename durable. */
async function flushFolder(folder: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.promises.open(folder, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/**
 * The final rename. On Windows a scanner may hold a fresh .exe open for a
 * moment (EPERM in 3 of 28 measured runs), so a refusal there is tried again
 * for up to RENAME_RETRY_MS. Elsewhere the same codes are a real permission
 * problem and fail at once.
 */
async function renameLast(from: string, to: string): Promise<void> {
  const deadline = Date.now() + RENAME_RETRY_MS;
  for (;;) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (error) {
      if (process.platform !== "win32" || !RENAME_RETRY_CODES.has(String(errorCode(error))) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(RENAME_WAIT_MS, Math.max(0, deadline - Date.now()))));
    }
  }
}

type Read =
  | { readonly kind: "complete" }
  | { readonly kind: "mismatch"; readonly detail: string }
  | { readonly kind: "no-space" }
  | { readonly kind: "write-failed"; readonly detail: string }
  | { readonly kind: "too-slow"; readonly detail: string };

/** The artifact's body: counted, size-capped, hashed and written as it arrives. */
function toFile(handle: fs.promises.FileHandle, artifact: ReleaseArtifact, o: DownloadOptions): { body: Body<Read>; received: () => number } {
  const now = o.now ?? Date.now;
  const slowest = o.slowest ?? SLOWEST;
  const hash = createHash("sha512");
  let received = 0;
  let windowStart = now();
  let windowBytes = 0;
  const body: Body<Read> = {
    declared: (length) => (length > artifact.size ? { kind: "mismatch", detail: `the server offered ${length} bytes; the signed list says ${artifact.size}` } : undefined),
    chunk: async (bytes) => {
      received += bytes.length;
      // Past the signed size: stop here, before writing, and hang up.
      if (received > artifact.size) return { kind: "mismatch", detail: `the server sent more than the ${artifact.size} bytes the signed list says` };
      hash.update(bytes);
      const at = received - bytes.length;
      try {
        for (let done = 0; done < bytes.length;) done += (await handle.write(bytes, done, bytes.length - done, at + done)).bytesWritten;
      } catch (error) {
        return errorCode(error) === "ENOSPC" ? { kind: "no-space" } : { kind: "write-failed", detail: message(error) };
      }
      o.progress?.(received, artifact.size);
      windowBytes += bytes.length;
      const t = now();
      if (t - windowStart >= slowest.windowMs) {
        if (windowBytes < slowest.bytes) return { kind: "too-slow", detail: `the download was slower than ${slowest.bytes} bytes in ${slowest.windowMs / 1000} seconds` };
        windowStart = t;
        windowBytes = 0;
      }
      return undefined;
    },
    end: () => {
      if (received !== artifact.size) return { kind: "mismatch", detail: `the server sent ${received} bytes; the signed list says ${artifact.size}` };
      if (hash.digest("hex") !== artifact.sha512) return { kind: "mismatch", detail: "the file's SHA-512 does not match the signed list" };
      return { kind: "complete" };
    },
  };
  return { body, received: () => received };
}

/**
 * Prepare version for this copy: reuse a folder that checks out, otherwise
 * delete what is there and download it again. Ends ready only through
 * verifyPrepared. Every other ending leaves no folder behind.
 */
export async function downloadRelease(o: DownloadOptions): Promise<DownloadOutcome> {
  // From the bytes in hand, before any file call: the name, then the list.
  let folder: string;
  try { folder = versionFolder(o.dataDir, o.version); }
  catch (error) { return { kind: "could-not-download", detail: message(error) }; }
  const trusted = trustList(o.list, o.signature, o.version, o);
  if (typeof trusted === "string") return { kind: "could-not-download", detail: trusted };
  const { artifact } = trusted;
  let final: string;
  try { final = fileIn(folder, artifact.file); }
  catch (error) { return { kind: "could-not-download", detail: message(error) }; }
  try {
    const existing = await preparedRelease(o);
    if (existing?.ok === true) return { kind: "ready", prepared: existing.prepared, fetched: false };
    // preparedRelease deleted a folder that failed; anything else left is not trusted either.
    await removeVersion(o.dataDir, o.version);
    if (o.signal.aborted) return { kind: "cancelled" };
    const outcome = await fetchInto(folder, final, artifact, o);
    if (outcome !== undefined) {
      await removeVersion(o.dataDir, o.version);
      return outcome;
    }
  } catch (error) {
    await removeVersion(o.dataDir, o.version).catch(() => undefined);
    if (o.signal.aborted) return { kind: "cancelled" };
    if (errorCode(error) === "ENOSPC") return disk(o, artifact);
    return { kind: "could-not-download", detail: message(error) };
  }
  const verified = await verifyPrepared(o);
  return verified.ok ? { kind: "ready", prepared: verified.prepared, fetched: true } : { kind: "bad-download", detail: verified.reason, received: artifact.size };
}

async function disk(o: DownloadOptions, artifact: ReleaseArtifact): Promise<DownloadOutcome> {
  const root = updatesRoot(o.dataDir);
  const space = await (o.freeSpace ?? freeSpace)(await fs.promises.stat(root).then(() => root, () => o.dataDir));
  return { kind: "disk", volume: space.volume, needed: artifact.size, free: space.free };
}

/** Steps 1 to 3 into an empty folder; final is fileIn's path. Undefined when the file is in place, else why not. */
async function fetchInto(folder: string, final: string, artifact: ReleaseArtifact, o: DownloadOptions): Promise<DownloadOutcome | undefined> {
  await fs.promises.mkdir(updatesRoot(o.dataDir), { recursive: true });
  const space = await (o.freeSpace ?? freeSpace)(updatesRoot(o.dataDir));
  if (space.free < artifact.size) return { kind: "disk", volume: space.volume, needed: artifact.size, free: space.free };
  await fs.promises.mkdir(folder);
  await writeFlushed(path.join(folder, LIST_FILE), o.list);
  await writeFlushed(path.join(folder, SIGNATURE_FILE), o.signature);
  const part = `${final}${PART}`;
  const handle = await fs.promises.open(part, "wx");
  let read: Streamed<Read> | undefined;
  let taken = 0;
  try {
    const sink = toFile(handle, artifact, o);
    read = await o.stream(artifactUrl(o.base, o.version, artifact.file), sink.body, o.signal);
    taken = sink.received();
    if (isComplete(read)) await handle.sync();
  } finally {
    await handle.close();
  }
  if (o.signal.aborted) return { kind: "cancelled" };
  if (isComplete(read)) {
    await renameLast(part, final);
    await flushFolder(folder);
    return undefined;
  }
  return failure(read, taken, artifact, o);
}

const isComplete = (read: Streamed<Read> | undefined) => read?.kind === "complete";

async function failure(r: Streamed<Read> | undefined, taken: number, artifact: ReleaseArtifact, o: DownloadOptions): Promise<DownloadOutcome> {
  switch (r?.kind) {
    case "mismatch": return { kind: "bad-download", detail: r.detail, received: taken };
    case "no-space": return disk(o, artifact);
    case "missing": return { kind: "could-not-download", detail: "the server has no such file" };
    case "failed": case "write-failed": case "too-slow": return { kind: "could-not-download", detail: r.detail };
    default: return { kind: "could-not-download", detail: "the download ended without an answer" };
  }
}
