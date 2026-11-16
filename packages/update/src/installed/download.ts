import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type ReleaseArtifact, type ReleaseManifest, validateReleaseVersion, verifyManifest } from "../release-manifest.ts";
import { compare, parseRelease } from "../semver.ts";
import type { Body, Stream, Streamed } from "./feed.ts";
import { inUse, type Look, once, real, realLook, STARTED_FILE } from "./in-use.ts";

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

/**
 * Who is asking: which keys, which running version, which platform's file.
 * A prepared version must be above `running`. `programs` are the running
 * program's files: no delete removes a version folder that holds one.
 */
export interface Identity {
  readonly dataDir: string;
  readonly running: string;
  readonly keys: readonly string[];
  readonly platform: string;
  readonly arch: string;
  readonly programs?: readonly string[];
  readonly look?: Look;
}

/**
 * A folder verifyPrepared has just checked from its bytes on disk.
 * `listSha512` is the SHA-512 of the stored list's exact bytes: the approval pin (design section 5).
 */
export interface PreparedRelease {
  readonly version: string;
  readonly folder: string;
  readonly file: string;
  readonly artifact: ReleaseArtifact;
  readonly manifest: ReleaseManifest;
  readonly listSha512: string;
}

export type Verified = { readonly ok: true; readonly prepared: PreparedRelease } | { readonly ok: false; readonly reason: string };

/** `bad-download`: the bytes did not match the signed list (size or hash); `received` is how many were taken. */
export type DownloadOutcome =
  | { readonly kind: "ready"; readonly prepared: PreparedRelease; readonly fetched: boolean }
  | { readonly kind: "bad-download"; readonly detail: string; readonly received: number }
  | { readonly kind: "could-not-download"; readonly detail: string }
  | { readonly kind: "disk"; readonly volume: string; readonly needed: number; readonly free: number }
  | { readonly kind: "cancelled" };

/** `volume`: the mount point (Linux) or drive (Windows) the folder is on. */
export interface Space {
  readonly volume: string;
  readonly free: number;
}

/**
 * `base` is the release page base B. `version` is the one the check found and
 * must be the list's own; `list` is the exact bytes the check fetched and verified.
 */
export interface DownloadOptions extends Identity {
  readonly base: URL;
  readonly version: string;
  readonly list: Buffer;
  readonly signature: Buffer;
  readonly stream: Stream;
  readonly signal: AbortSignal;
  readonly progress?: (received: number, total: number) => void;
  readonly freeSpace?: (folder: string) => Promise<Space>;
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

async function removeVersion(dataDir: string, version: string, who: { readonly programs?: readonly string[] | undefined; readonly look?: Look | undefined }): Promise<string | null> {
  const folder = versionFolder(dataDir, version);
  const used = inUse(folder, who.programs ?? [], who.look ?? realLook);
  if (used !== null) return used;
  // external: on Windows a scanner may hold a fresh file for a moment; the retries ride that out.
  await fs.promises.rm(folder, { recursive: true, force: true, maxRetries: 3 });
  return null;
}

/** Whether file runs from inside <data dir>/updates/, the folder this updater downloads into and cleans. */
export function inUpdatesFolder(dataDir: string, file: string): boolean {
  return real(file).startsWith(`${real(updatesRoot(dataDir))}${path.sep}`);
}

/**
 * A copy that finds itself started from program calls this: when program is
 * inside a version folder under updates/, it leaves a note there with the
 * time, and from then on no cleanup deletes that folder. Returns the folder,
 * or null when program is not in one. Throws when the note cannot be written.
 */
export function noteStartedFrom(dataDir: string, program: string, now: Date = new Date()): string | null {
  const root = real(updatesRoot(dataDir));
  const file = real(program);
  if (!file.startsWith(`${root}${path.sep}`)) return null;
  const version = file.slice(root.length + 1).split(path.sep)[0] ?? "";
  let folder: string;
  try { folder = versionFolder(dataDir, version); } catch { return null; }
  fs.writeFileSync(path.join(folder, STARTED_FILE), `${now.toISOString()}\n`);
  return folder;
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
  await removeVersion(o.dataDir, o.version, o);
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
  const exists = await fs.promises.lstat(folder).then(() => true, () => false);
  if (!exists) return null;
  const verified = await verifyPrepared(o);
  if (!verified.ok || verified.prepared.listSha512 === listHash(o.list)) return verified;
  await removeVersion(o.dataDir, o.version, o);
  return { ok: false, reason: "the folder holds another signed list for this version" };
}

/**
 * Deletes the version folders under updates/ that keep does not name, except
 * any that could be in use and the newest one: the newest on disk, unless
 * keep names a newer version still (the one being fetched). The newest is the
 * file a copy that cannot replace itself told the person to start. Returns
 * the versions deleted.
 */
export async function removeVersions(dataDir: string, keep: readonly string[], programs: readonly string[] = [], look: Look = realLook): Promise<readonly string[]> {
  const entries = await fs.promises.readdir(updatesRoot(dataDir), { withFileTypes: true }).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  });
  const isVersion = (name: string) => {
    try { versionFolder(dataDir, name); return true; } catch { return false; }
  };
  const versions = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).filter(isVersion);
  const newest = [...versions, ...keep.filter(isVersion)].reduce<string | undefined>((best, name) => (best === undefined || newer(name, best) ? name : best), undefined);
  const who = { programs, look: once(look) };
  const removed: string[] = [];
  for (const name of versions) {
    if (name === newest || keep.includes(name)) continue;
    if ((await removeVersion(dataDir, name, who)) === null) removed.push(name);
  }
  return removed;
}

function newer(a: string, b: string): boolean {
  const [left, right] = [parseRelease(`v${a}`), parseRelease(`v${b}`)];
  return left !== null && right !== null && compare(left, right) > 0;
}

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

async function writeFlushed(file: string, bytes: Buffer): Promise<void> {
  const handle = await fs.promises.open(file, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// external: Windows cannot open a folder to flush it; elsewhere this makes the rename durable.
async function flushFolder(folder: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.promises.open(folder, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

// external: on Windows a scanner may hold a fresh .exe open for a moment (EPERM in 3 of 28 runs).
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
    // why: preparedRelease deleted a folder that failed; anything else left is not trusted either.
    const used = await removeVersion(o.dataDir, o.version, o);
    if (used !== null) return { kind: "could-not-download", detail: `its folder is in use: ${used}` };
    if (o.signal.aborted) return { kind: "cancelled" };
    const outcome = await fetchInto(folder, final, artifact, o);
    if (outcome !== undefined) {
      await removeVersion(o.dataDir, o.version, o);
      return outcome;
    }
  } catch (error) {
    await removeVersion(o.dataDir, o.version, o).catch(() => undefined);
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

async function fetchInto(folder: string, final: string, artifact: ReleaseArtifact, o: DownloadOptions): Promise<DownloadOutcome | undefined> {
  await fs.promises.mkdir(updatesRoot(o.dataDir), { recursive: true });
  const space = await (o.freeSpace ?? freeSpace)(updatesRoot(o.dataDir));
  if (space.free < artifact.size) return { kind: "disk", volume: space.volume, needed: artifact.size, free: space.free };
  await fs.promises.mkdir(folder);
  await writeFlushed(path.join(folder, LIST_FILE), o.list);
  await writeFlushed(path.join(folder, SIGNATURE_FILE), o.signature);
  const part = `${final}${PART}`;
  const handle = await fs.promises.open(part, "wx", artifact.kind === "appimage" ? 0o755 : 0o644);
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
