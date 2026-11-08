// Own-folder Ollama install (D1): download the pinned asset into a staging
// directory, verify sha256 while streaming, extract, then rename the tree
// into runtime/ollama/<version>/ in one step. Any failure removes staging, so
// no half-installed version is ever visible. No root, no package manager.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { access, constants, mkdir, mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { binaryIn, installDir, installRoot, installedBinary, runtimeDir } from "./paths.ts";
import type { InstallManifest } from "./schemas.ts";
import type { InstallProgress } from "./types.ts";

export type InstallErrorCode =
  | "unverified-manifest"
  | "download-failed"
  | "interrupted"
  | "hash-mismatch"
  | "extract-failed";

export class InstallError extends Error {
  readonly code: InstallErrorCode;
  constructor(code: InstallErrorCode, message: string) {
    super(message);
    this.name = "InstallError";
    this.code = code;
  }
}

export type InstallOptions = {
  appDataDir: string;
  manifest: InstallManifest;
  onProgress?: (p: InstallProgress) => void;
  signal?: AbortSignal;
  /** Progress events during download fire at most this often. */
  progressIntervalMs?: number;
};

export type InstallResult = { version: string; dir: string; binary: string; alreadyInstalled: boolean };

const STAGING_PREFIX = ".staging-";

export function isInstalled(appDataDir: string, version: string): boolean {
  return existsSync(installedBinary(appDataDir, version));
}

async function removeStaleStaging(appDataDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(runtimeDir(appDataDir));
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((e) => e.startsWith(STAGING_PREFIX))
      .map((e) => rm(path.join(runtimeDir(appDataDir), e), { recursive: true, force: true })),
  );
}

const mib = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MiB`;

async function download(opts: InstallOptions, file: string): Promise<string> {
  const { manifest, onProgress, signal } = opts;
  const interval = opts.progressIntervalMs ?? 250;
  const retry = "Check the network and retry; nothing was installed.";
  let res: Response;
  try {
    res = await fetch(manifest.url, signal ? { signal } : {});
  } catch (e) {
    throw new InstallError("download-failed", `Could not reach ${manifest.url} (${(e as Error).message}). ${retry}`);
  }
  if (!res.ok || !res.body) {
    throw new InstallError("download-failed", `Downloading Ollama ${manifest.version} failed: HTTP ${res.status} from ${manifest.url}. ${retry}`);
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
      received += buf.length;
      if (received > manifest.sizeBytes) {
        throw new InstallError(
          "hash-mismatch",
          `The Ollama ${manifest.version} download is larger than the pinned ${manifest.sizeBytes} bytes, so it is not the pinned release. Nothing was installed; the pinned manifest needs updating.`,
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
    throw new InstallError(
      "interrupted",
      `The Ollama download stopped at ${mib(received)} of ${mib(manifest.sizeBytes)} (${(e as Error).message}). ${retry}`,
    );
  } finally {
    await fh.close();
  }
  emit();
  if (received !== manifest.sizeBytes) {
    throw new InstallError(
      "interrupted",
      `The Ollama download ended early: ${mib(received)} of ${mib(manifest.sizeBytes)}. ${retry}`,
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

function extractZip(archive: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tar = spawn(windowsTar(), ["-x", "-f", archive, "-C", into], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    tar.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    tar.on("error", (e) => reject(e));
    tar.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `tar exited ${code}`))));
  });
}

function extract(archive: string, format: InstallManifest["format"], into: string): Promise<void> {
  if (format === "zip") return extractZip(archive, into);
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
  const { appDataDir, manifest, onProgress } = opts;
  const dir = installDir(appDataDir, manifest.version);
  const binary = installedBinary(appDataDir, manifest.version);
  if (isInstalled(appDataDir, manifest.version)) return { version: manifest.version, dir, binary, alreadyInstalled: true };
  if (!manifest.verified) {
    throw new InstallError(
      "unverified-manifest",
      `The pinned Ollama ${manifest.version} has no confirmed checksum, so the app will not install it. Install Ollama yourself or update the pinned manifest.`,
    );
  }
  await mkdir(runtimeDir(appDataDir), { recursive: true });
  await removeStaleStaging(appDataDir);
  const staging = await mkdtemp(path.join(runtimeDir(appDataDir), STAGING_PREFIX));
  try {
    const archive = path.join(staging, "asset");
    const digest = await download(opts, archive);
    onProgress?.({ phase: "verify", version: manifest.version, receivedBytes: manifest.sizeBytes, totalBytes: manifest.sizeBytes });
    if (digest !== manifest.sha256.toLowerCase()) {
      throw new InstallError(
        "hash-mismatch",
        `The Ollama ${manifest.version} download did not match its pinned checksum (expected sha256 ${manifest.sha256}, got ${digest}). Nothing was installed. Retry once; if it fails again the release file changed and the pinned manifest needs updating.`,
      );
    }
    onProgress?.({ phase: "extract", version: manifest.version, receivedBytes: manifest.sizeBytes, totalBytes: manifest.sizeBytes });
    const tree = path.join(staging, "tree");
    await mkdir(tree);
    try {
      await extract(archive, manifest.format, tree);
      await access(binaryIn(tree), constants.X_OK);
    } catch (e) {
      throw new InstallError(
        "extract-failed",
        `Unpacking Ollama ${manifest.version} failed (${(e as Error).message}). Nothing was installed; check free disk space in ${appDataDir} and retry.`,
      );
    }
    await mkdir(installRoot(appDataDir), { recursive: true });
    try {
      await rename(tree, dir);
    } catch (e) {
      // Another install finished first; keep its tree.
      if (!isInstalled(appDataDir, manifest.version)) throw e;
    }
    onProgress?.({ phase: "done", version: manifest.version, receivedBytes: manifest.sizeBytes, totalBytes: manifest.sizeBytes });
    return { version: manifest.version, dir, binary, alreadyInstalled: false };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
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
