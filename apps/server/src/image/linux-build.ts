// The image engine on Linux x64. No portable exists, so the tree is built from pinned parts, with
// the same installer as Ollama and the Windows engine (installPinned: pinned URL, sha256 checked
// while streaming, staged and renamed) for the two archives, and uv for the rest:
//
//   runtime/uv/<uv version>/            uv, one static binary (pinned archive)
//   runtime/comfyui-src/<version>/      ComfyUI's source (pinned archive)
//   runtime/uv-python/                  uv's standalone Python (uv checks it against the
//                                       digests built into the pinned uv)
//   runtime/comfyui/<version>/          the engine: ComfyUI/ and venv/, built in a staging
//                                       folder beside it and renamed into place whole
//
// The wheels (torch and ComfyUI's requirements) come from `uv pip sync --require-hashes` against
// the lock below: a wheel whose hash is not in the lock is refused. No root, no system Python.
import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, cp, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { installPinned, type InstallTarget } from "../runtime/install.ts";
import { runtimeDir } from "../runtime/paths.ts";
import type { InstallManifest } from "../runtime/schemas.ts";
import type { InstallProgress } from "../runtime/types.ts";
import { ENGINE_VERSION, engineDir, engineRoot } from "./engine.ts";
import { LINUX_LOCK, LINUX_WHEEL_BYTES } from "./linux-lock.ts";
import type { EnginePlan } from "./setup.ts";

export type LinuxPins = {
  /** The engine's version: its folder under runtime/comfyui/. */
  version: string;
  /** The Python uv builds the venv with (one of its standalone builds). */
  python: string;
  uv: InstallManifest;
  /** The folder the uv archive unpacks to. */
  uvDir: string;
  source: InstallManifest;
  /** The folder the source archive unpacks to. */
  sourceDir: string;
  /** `uv pip compile --generate-hashes --emit-index-url` output: every wheel, its index and its sha256. */
  lock: string;
  /** What the wheels download, for the progress and the free-space check. */
  wheelBytes: number;
};

/**
 * Pinned 2026-11-13: uv's release archive and the v0.44.0 tag archive were each fetched once on a
 * test machine, their sha256 and size read and checked against uv's published digest; the lock
 * (linux-lock.ts) was compiled from the source's requirements.txt. Offered only once the release
 * switch (ENGINE_OFFERED in engine.ts) is on.
 */
export const LINUX_ENGINE: LinuxPins = {
  version: ENGINE_VERSION,
  python: "3.13",
  uv: {
    version: "0.13.7",
    url: "https://github.com/astral-sh/uv/releases/download/0.13.7/uv-x86_64-unknown-linux-gnu.tar.gz",
    sha256: "c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83",
    sizeBytes: 16_671_812, format: "tar.gz", verified: true,
    source: "uv release asset digest and size, checked against one download, 2026-11-13",
  },
  uvDir: "uv-x86_64-unknown-linux-gnu",
  source: {
    version: ENGINE_VERSION,
    url: `https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/v${ENGINE_VERSION}.tar.gz`,
    sha256: "7d796d74f42fe862eb55d1c217349fee92c2cac5d4ababe06c8b73f90c936dc0",
    sizeBytes: 12_864_357, format: "tar.gz", verified: true,
    source: "one download of the tag archive, sha256 and size read, 2026-11-13",
  },
  sourceDir: `ComfyUI-${ENGINE_VERSION}`,
  lock: LINUX_LOCK,
  wheelBytes: LINUX_WHEEL_BYTES,
};

/** Every part has its digest and the lock is filled in: the build may be offered. */
export const linuxPinned = (pins: LinuxPins): boolean => pins.uv.verified && pins.source.verified && pins.lock !== "";

const BUILD_PREFIX = ".build-";

const target = (appDataDir: string, label: string, folder: string, inside: string): InstallTarget => ({
  label, name: `the ${label}`,
  root: path.join(runtimeDir(appDataDir), folder),
  stagingRoot: path.join(runtimeDir(appDataDir), folder),
  check: (tree) => access(path.join(tree, inside), constants.R_OK),
});

const UNITS: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };
/** A terminal colour code, should uv print one (FORCE_COLOR in the app's environment). */
const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * The bytes uv's sync has finished downloading, from its own lines. With its output not a terminal
 * uv prints no bars; for each file over 1 MiB it prints "Downloading torch (846.4MiB)" when the
 * download starts and " Downloaded torch" when it ends (uv-command-support progress.rs, 0.13.7).
 * A wheel counts once it has ended, at the size uv gave it; smaller wheels say nothing and are
 * counted when the sync ends. Never more than `cap`.
 */
export function uvDownloads(cap: number): (line: string) => number {
  const sizes = new Map<string, number>();
  let done = 0;
  return (line) => {
    const text = line.replace(COLOUR, "").trim();
    const start = /^Downloading (\S+) \((\d+(?:\.\d+)?)(B|KiB|MiB|GiB|TiB)\)$/.exec(text);
    if (start) sizes.set(start[1]!, Math.round(Number(start[2]) * UNITS[start[3]!]!));
    const end = /^Downloaded (\S+)$/.exec(text);
    if (end) { done += sizes.get(end[1]!) ?? 0; sizes.delete(end[1]!); }
    return Math.min(done, cap);
  };
}

/** Run uv to the end; a failure carries the end of what it printed. `onLine` hears each line it prints. */
function runUv(uv: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal, onLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let run: ChildProcess;
    try { run = spawn(uv, args, { env, stdio: ["ignore", "ignore", "pipe"], signal }); }
    catch (error) { reject(error as Error); return; }
    let tail = "", partial = "";
    run.stderr?.on("data", (c: Buffer) => {
      const text = c.toString("utf8");
      tail = (tail + text).slice(-2000);
      if (onLine === undefined) return;
      const lines = (partial + text).split(/\r?\n/);
      partial = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    });
    run.once("error", reject);
    run.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Building the image engine failed (uv ${args[0]}: ${tail.trim().split("\n").at(-1) ?? `exit ${code}`}). Nothing was installed.`));
    });
  });
}

export function linuxBuild(opts: { appDataDir: string; pins: LinuxPins }): Extract<EnginePlan, { kind: "build" }> {
  const { appDataDir, pins } = opts;
  const bytes = pins.uv.sizeBytes + pins.source.sizeBytes + pins.wheelBytes;
  return {
    kind: "build",
    version: pins.version,
    bytes,
    async run(onProgress, signal) {
      let before = 0;
      const part = (size: number) => (p: InstallProgress) => onProgress({ ...p, receivedBytes: before + Math.min(p.receivedBytes, size), totalBytes: bytes });
      const uvBin = path.join(pins.uvDir, "uv");
      const uv = await installPinned({ appDataDir, manifest: pins.uv, target: target(appDataDir, "uv tool", "uv", uvBin), onProgress: part(pins.uv.sizeBytes), signal });
      before += pins.uv.sizeBytes;
      const source = await installPinned({ appDataDir, manifest: pins.source, target: target(appDataDir, "ComfyUI source", "comfyui-src", path.join(pins.sourceDir, "main.py")), onProgress: part(pins.source.sizeBytes), signal });
      before += pins.source.sizeBytes;

      const root = engineRoot(appDataDir);
      await mkdir(root, { recursive: true });
      // a build a killed app left behind (own.ts skips dot folders, so it was never started)
      for (const entry of await readdir(root)) if (entry.startsWith(BUILD_PREFIX)) await rm(path.join(root, entry), { recursive: true, force: true });
      const staging = await mkdtemp(path.join(root, BUILD_PREFIX));
      try {
        await cp(path.join(source.dir, pins.sourceDir), path.join(staging, "ComfyUI"), { recursive: true });
        const lock = path.join(staging, "requirements.lock");
        await writeFile(lock, pins.lock);
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          UV_CACHE_DIR: path.join(runtimeDir(appDataDir), "uv-cache"),
          UV_PYTHON_INSTALL_DIR: path.join(runtimeDir(appDataDir), "uv-python"),
          UV_PYTHON_PREFERENCE: "only-managed",
          UV_NO_CONFIG: "1",
        };
        const venv = path.join(staging, "venv");
        // --relocatable: the venv still runs once the staging folder is renamed into place
        await runUv(path.join(uv.dir, uvBin), ["venv", "--relocatable", "--python", pins.python, venv], env, signal);
        // best-match, as the lock was compiled: first-index would take certifi and the like from
        // the torch index, which lacks the pinned versions
        // the wheels are most of the download: each one uv says it finished moves the count
        const wheels = uvDownloads(pins.wheelBytes);
        let counted = 0;
        await runUv(path.join(uv.dir, uvBin), ["pip", "sync", "--require-hashes", "--index-strategy", "unsafe-best-match", "--python", path.join(venv, "bin", "python"), lock], env, signal, (line) => {
          const now = wheels(line);
          if (now === counted) return;
          counted = now;
          onProgress({ phase: "download", version: pins.version, receivedBytes: before + now, totalBytes: bytes });
        });
        await access(path.join(venv, "bin", "python"), constants.X_OK);
        await rename(staging, engineDir(appDataDir, pins.version));
        onProgress({ phase: "done", version: pins.version, receivedBytes: bytes, totalBytes: bytes });
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    },
  };
}
