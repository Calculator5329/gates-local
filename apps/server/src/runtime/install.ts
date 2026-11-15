// Own-folder Ollama install (D1): download the pinned asset into a staging
// directory, verify sha256 while streaming, extract, then rename the tree
// into runtime/ollama/<version>/ in one step. A failure removes staging, so
// no half-installed version is ever visible, except a refused final move:
// its checked tree stays in staging (still invisible) for the Retry to move.
// No root, no package manager.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { access, constants, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { NBSP, gb } from "@gates-local/contracts";
import { volumeFree } from "../image/download.ts";
import { binaryIn, installRoot, installedBinary, runtimeDir } from "./paths.ts";
import type { InstallManifest } from "./schemas.ts";
import type { InstallProgress } from "./types.ts";

/** A drive without room for a download: both sizes in GB to one decimal (image setup says it the same way). */
const diskGb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
export const shortDisk = (need: number, free: number) => `Needs ${diskGb(need)} free; ${diskGb(free)} is free on this drive.`;

export type InstallErrorCode =
  | "unverified-manifest"
  | "download-failed"
  | "interrupted"
  | "hash-mismatch"
  | "extract-failed"
  | "disk-full"
  | "move-failed";

export class InstallError extends Error {
  readonly code: InstallErrorCode;
  constructor(code: InstallErrorCode, message: string) {
    super(message);
    this.name = "InstallError";
    this.code = code;
  }
}

/**
 * What a pinned release installs into. Ollama is the default; the image
 * engine (image/engine.ts) is the other. Each target's staging folders sit
 * where only its own installs clear them.
 */
export type InstallTarget = {
  /** Its name in "The … download": "Ollama", "image engine". */
  label: string;
  /** Its name mid-sentence: "Ollama", "the image engine". */
  name: string;
  /** One folder per version. */
  root: string;
  /** Where staging folders go; stale ones there are cleared on each install. */
  stagingRoot: string;
  /** Rejects unless an unpacked tree is whole. */
  check(tree: string): Promise<void>;
};

export function ollamaTarget(appDataDir: string): InstallTarget {
  return {
    label: "Ollama",
    name: "Ollama",
    root: installRoot(appDataDir),
    stagingRoot: runtimeDir(appDataDir),
    check: (tree) => access(binaryIn(tree), constants.X_OK),
  };
}

export type InstallOptions = {
  appDataDir: string;
  manifest: InstallManifest;
  /** Ollama when absent. */
  target?: InstallTarget;
  onProgress?: (p: InstallProgress) => void;
  signal?: AbortSignal;
  /** Progress events during download fire at most this often. */
  progressIntervalMs?: number;
  /** The download ends as interrupted after this long with no bytes (DOWNLOAD_IDLE_MS when absent). */
  idleMs?: number;
  /** Free bytes on the drive that holds `dir`; tests pretend a short disk. The real volume when absent. */
  freeBytes?: (dir: string) => Promise<number>;
  /** Whether a refused final move is tried again, as a scanner on Windows refuses one (process.platform when absent). */
  windows?: boolean;
  /** How long a refused move is tried again (MOVE_RETRY_MS when absent). */
  moveRetryMs?: number;
};

/**
 * The final move. On Windows a scanner may hold a fresh .exe or .dll open for a moment and the
 * move is refused (EPERM, EACCES or EBUSY), so it is tried again for MOVE_RETRY_MS, as the update
 * download does with its own (update/installed/download.ts renameLast). A tree of hundreds of
 * libraries gives a scanner more to read than one release folder, so the bound is longer.
 * Elsewhere the same codes are a real permission problem and fail at once.
 */
export const MOVE_RETRY_MS = 5_000;
const MOVE_WAIT_MS = 100;
const MOVE_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

async function moveLast(from: string, to: string, windows: boolean, retryMs: number): Promise<void> {
  const deadline = Date.now() + retryMs;
  for (;;) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = String((error as { code?: unknown }).code);
      if (!windows || !MOVE_RETRY_CODES.has(code) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(MOVE_WAIT_MS, Math.max(0, deadline - Date.now()))));
    }
  }
}

/** In a staging folder whose tree was checked: which release it is, so a Retry after a refused move uses it with no download. */
const CHECKED_NOTE = "checked.json";
type CheckedNote = { version: string; sha256: string };

const hashFile = async (file: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
};

/** What a kept staging folder still holds for this release: its tree whole, or only its archive. */
type Kept = { staging: string; tree: boolean };

/**
 * The staging folder a refused move left for this release: its tree, when it is still whole, or
 * its archive, when it still hashes to the pin. Undefined when there is none.
 */
async function keptStaging(stagingRoot: string, manifest: InstallManifest, target: InstallTarget): Promise<Kept | undefined> {
  let entries: string[];
  try {
    entries = await readdir(stagingRoot);
  } catch {
    return undefined;
  }
  const pin = manifest.sha256.toLowerCase();
  for (const e of entries.filter((x) => x.startsWith(STAGING_PREFIX))) {
    const staging = path.join(stagingRoot, e);
    const note = await readFile(path.join(staging, CHECKED_NOTE), "utf8").then((t) => JSON.parse(t) as Partial<CheckedNote>, () => undefined);
    if (note?.version !== manifest.version || note.sha256?.toLowerCase() !== pin) continue;
    if (await target.check(path.join(staging, "tree")).then(() => true, () => false)) return { staging, tree: true };
    if ((await hashFile(path.join(staging, "asset")).catch(() => undefined)) === pin) return { staging, tree: false };
  }
  return undefined;
}

/**
 * The disk an install takes at once: the archive and, beside it until staging goes, the unpacked
 * copy. Where the unpacked size was never measured, at least the archive's size again.
 */
export const installNeed = (m: Pick<InstallManifest, "sizeBytes" | "unpackedBytes">): number => m.sizeBytes + (m.unpackedBytes ?? m.sizeBytes);

/** A write refused for a full disk (or a full quota), as an error code or in tar's words. */
const diskFull = (e: unknown): boolean => {
  const code = (e as { code?: unknown } | undefined)?.code;
  return code === "ENOSPC" || code === "EDQUOT" || /no space left on device|disk quota exceeded/i.test(String((e as Error | undefined)?.message));
};


/**
 * No bytes for this long ends a download. Node's fetch would wait 300 s (undici's bodyTimeout and
 * headersTimeout), with the speed and time left frozen on screen and Retry handed the stalled attempt.
 */
export const DOWNLOAD_IDLE_MS = 30_000;

export type InstallResult = { version: string; dir: string; binary: string; alreadyInstalled: boolean };

const STAGING_PREFIX = ".staging-";

export function isInstalled(appDataDir: string, version: string): boolean {
  return existsSync(installedBinary(appDataDir, version));
}

async function removeStaleStaging(stagingRoot: string, keep?: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(stagingRoot);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((e) => e.startsWith(STAGING_PREFIX) && path.join(stagingRoot, e) !== keep)
      .map((e) => rm(path.join(stagingRoot, e), { recursive: true, force: true })),
  );
}

/** "0.6 of 1.5 GB": how far a download got, in the figures the app counted it in while it ran (gb, the one size helper); one piece that never wraps. */
const sofar = (received: number, total: number) => `${(received / 1024 ** 3).toFixed(1)}${NBSP}of${NBSP}${gb(total)}`;

async function download(opts: InstallOptions & { target: InstallTarget }, file: string): Promise<string> {
  const { manifest, onProgress, signal } = opts;
  const { label, name } = opts.target;
  const interval = opts.progressIntervalMs ?? 250;
  const retry = "Check the network and retry; nothing was installed.";
  // An idle bound, re-armed by every chunk: the connection that stops sending ends here, not at fetch's own 300 s.
  const idleMs = opts.idleMs ?? DOWNLOAD_IDLE_MS;
  const idle = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(new Error(`no data for ${(idleMs / 1000).toFixed(idleMs < 1000 ? 1 : 0)}${NBSP}s`)), idleMs);
  };
  const reason = (e: unknown) => (idle.signal.aborted ? (idle.signal.reason as Error).message : (e as Error).message);
  arm();
  let res: Response;
  try {
    res = await fetch(manifest.url, { signal: signal ? AbortSignal.any([signal, idle.signal]) : idle.signal });
  } catch (e) {
    clearTimeout(timer);
    throw new InstallError("download-failed", `Could not reach ${manifest.url} (${reason(e)}). ${retry}`);
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    throw new InstallError("download-failed", `Downloading ${name} failed: HTTP ${res.status} from ${manifest.url}. ${retry}`);
  }
  const hash = createHash("sha256");
  const fh = await open(file, "w");
  let received = 0;
  let lastEmit = 0;
  const emit = () => onProgress?.({ phase: "download", version: manifest.version, receivedBytes: received, totalBytes: manifest.sizeBytes });
  emit();
  try {
    for await (const chunk of Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>)) {
      const buf = chunk as Buffer;
      arm();
      received += buf.length;
      if (received > manifest.sizeBytes) {
        throw new InstallError(
          "hash-mismatch",
          `The ${label} download is larger than the pinned ${manifest.sizeBytes} bytes, so it is not the pinned release. Nothing was installed; the pinned manifest needs updating.`,
        );
      }
      hash.update(buf);
      await fh.write(buf);
      const now = Date.now();
      if (now - lastEmit >= interval) {
        lastEmit = now;
        emit();
      }
    }
  } catch (e) {
    if (e instanceof InstallError) throw e;
    // the disk, not the network: installPinned says how much it needs once staging is gone
    if (diskFull(e)) throw new InstallError("disk-full", "The disk is full.");
    throw new InstallError(
      "interrupted",
      `The ${label} download stopped at ${sofar(received, manifest.sizeBytes)} (${reason(e)}). ${retry}`,
    );
  } finally {
    clearTimeout(timer);
    await fh.close();
  }
  emit();
  if (received !== manifest.sizeBytes) {
    throw new InstallError(
      "interrupted",
      `The ${label} download ended early: ${sofar(received, manifest.sizeBytes)}. ${retry}`,
    );
  }
  return hash.digest("hex");
}

/**
 * Windows' own bsdtar (System32, Windows 10 1803 and later) reads ZIP and
 * refuses absolute and `..` entry paths. It is named by full path: a `tar`
 * earlier on PATH (Git's GNU tar) cannot read ZIP and takes "C:" for a host.
 */
export function windowsTar(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return path.win32.join(env["SystemRoot"] ?? env["SYSTEMROOT"] ?? "C:\\Windows", "System32", "tar.exe");
}

/**
 * ZIP and 7z go through libarchive: Windows' own tar.exe there (the image
 * engine's portable is a 7z with the BCJ2 filter, which libarchive reads),
 * bsdtar elsewhere (tests, and the 7z proof on Linux).
 */
function extractWithLibarchive(archive: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tar = spawn(process.platform === "win32" ? windowsTar() : "bsdtar", ["-x", "-f", archive, "-C", into], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    tar.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    tar.on("error", (e) => reject(e));
    tar.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `tar exited ${code}`))));
  });
}

function extract(archive: string, format: InstallManifest["format"], into: string): Promise<void> {
  if (format === "zip" || format === "7z") return extractWithLibarchive(archive, into);
  return new Promise((resolve, reject) => {
    const tar = spawn("tar", ["-x", "-f", "-", "-C", into, "--no-same-owner"], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    tar.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    const decompress = format === "tar.zst" ? zlib.createZstdDecompress() : zlib.createGunzip();
    const feed = pipeline(createReadStream(archive), decompress, tar.stdin);
    let fed: Error | undefined;
    feed.catch((e: Error) => {
      fed = e;
      tar.kill();
    });
    tar.on("error", (e) => reject(e));
    tar.on("close", (code) => {
      if (code === 0 && !fed) resolve();
      else reject(new Error(fed ? fed.message : stderr.trim() || `tar exited ${code}`));
    });
  });
}

/**
 * Install the pinned version unless it is already present. Throws
 * InstallError with a message a user can act on.
 */
export async function installPinned(opts: InstallOptions): Promise<InstallResult> {
  const { appDataDir, manifest } = opts;
  const target = opts.target ?? ollamaTarget(appDataDir);
  const { label } = target;
  const dir = path.join(target.root, manifest.version);
  const ollama = opts.target === undefined;
  const binary = ollama ? installedBinary(appDataDir, manifest.version) : dir;
  const present = async () => target.check(dir).then(() => true, () => false);
  if (await present()) return { version: manifest.version, dir, binary, alreadyInstalled: true };
  if (!manifest.verified) {
    throw new InstallError(
      "unverified-manifest",
      ollama
        ? `The pinned Ollama has no confirmed checksum, so the app will not install it. Install Ollama yourself or update the pinned manifest.`
        : `The pinned ${label} has no confirmed checksum and size, so the app will not download it. The pinned manifest needs its release's exact size and sha256.`,
    );
  }
  await mkdir(target.stagingRoot, { recursive: true });
  // a refused move's checked tree (or archive) is used again; any other staging is an earlier crash's
  const kept = await keptStaging(target.stagingRoot, manifest, target);
  await removeStaleStaging(target.stagingRoot, kept?.staging);
  // the archive and the unpacked copy sit on the disk together: a disk short of both is said before a byte downloads
  const need = kept === undefined ? installNeed(manifest) : kept.tree ? 0 : installNeed(manifest) - manifest.sizeBytes;
  const free = () => (opts.freeBytes ?? volumeFree)(target.stagingRoot).catch(() => undefined);
  const before = need === 0 ? undefined : await free();
  if (before !== undefined && before < need) throw new InstallError("disk-full", shortDisk(need, before));
  const staging = kept?.staging ?? (await mkdtemp(path.join(target.stagingRoot, STAGING_PREFIX)));
  const place: Place = { target, dir, binary, present, keep: false };
  try {
    return await placed(opts, staging, place, kept);
  } catch (e) {
    if (!diskFull(e) && !(e instanceof InstallError && e.code === "disk-full")) throw e;
    // what the attempt wrote goes first, so the free figure is the disk's own
    place.keep = false;
    await rm(staging, { recursive: true, force: true });
    const now = await free();
    throw new InstallError("disk-full", now === undefined ? `The disk is full. Needs ${gb(installNeed(manifest))} free.` : `The disk is full. ${shortDisk(installNeed(manifest), now)}`);
  } finally {
    if (!place.keep) await rm(staging, { recursive: true, force: true });
  }
}

/** Where one release goes, whether it is there, and whether its staging is kept for a Retry. */
type Place = { target: InstallTarget; dir: string; binary: string; present: () => Promise<boolean>; keep: boolean };

/** Download, check, unpack and move one release through its staging folder; `kept` skips what a refused move left. */
async function placed(opts: InstallOptions, staging: string, place: Place, kept: Kept | undefined): Promise<InstallResult> {
  const { appDataDir, manifest, onProgress } = opts;
  const { target, dir, binary, present } = place;
  const { label, name } = target;
  const archive = path.join(staging, "asset");
  const tree = path.join(staging, "tree");
  const whole = { version: manifest.version, receivedBytes: manifest.sizeBytes, totalBytes: manifest.sizeBytes };
  if (kept === undefined) {
    const digest = await download({ ...opts, target }, archive);
    onProgress?.({ phase: "verify", ...whole });
    if (digest !== manifest.sha256.toLowerCase()) {
      throw new InstallError(
        "hash-mismatch",
        `The ${label} download did not match its pinned checksum (expected sha256 ${manifest.sha256}, got ${digest}). Nothing was installed. Retry once; if it fails again the release file changed and the pinned manifest needs updating.`,
      );
    }
  }
  onProgress?.({ phase: "extract", ...whole });
  if (kept?.tree !== true) {
    // a kept archive's tree was not whole: it unpacks again from the start
    await rm(tree, { recursive: true, force: true });
    await mkdir(tree);
    try {
      await extract(archive, manifest.format, tree);
      await target.check(tree);
    } catch (e) {
      if (diskFull(e)) throw e;
      throw new InstallError(
        "extract-failed",
        `Unpacking ${name} failed (${(e as Error).message}). Nothing was installed; check free disk space in ${appDataDir} and retry.`,
      );
    }
    const note: CheckedNote = { version: manifest.version, sha256: manifest.sha256.toLowerCase() };
    await writeFile(path.join(staging, CHECKED_NOTE), JSON.stringify(note));
  }
  await mkdir(target.root, { recursive: true });
  try {
    await moveLast(tree, dir, opts.windows ?? process.platform === "win32", opts.moveRetryMs ?? MOVE_RETRY_MS);
  } catch (e) {
    // Another install finished first; keep its tree.
    if (!(await present())) {
      // the checked tree stays in staging, so a Retry moves it without downloading again
      place.keep = true;
      throw new InstallError(
        "move-failed",
        `${label} could not be moved into place (${(e as Error).message}). Another program, often a virus scanner, may be holding one of its files. The download is kept; Retry moves it again.`,
      );
    }
  }
  onProgress?.({ phase: "done", version: manifest.version, receivedBytes: manifest.sizeBytes, totalBytes: manifest.sizeBytes });
  return { version: manifest.version, dir, binary, alreadyInstalled: false };
}

/** Newest version directory under runtime/ollama/ that holds a binary. */
export async function findAnyInstalled(appDataDir: string): Promise<{ version: string; binary: string } | undefined> {
  let entries: string[];
  try {
    entries = await readdir(installRoot(appDataDir));
  } catch {
    return undefined;
  }
  const versions = entries
    .filter((e) => !e.startsWith("."))
    .filter((v) => isInstalled(appDataDir, v))
    .toSorted((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const v = versions[0];
  return v ? { version: v, binary: installedBinary(appDataDir, v) } : undefined;
}
