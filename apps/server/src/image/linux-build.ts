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
import { constants, readFileSync } from "node:fs";
import { access, cp, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { installPinned, type InstallTarget } from "../runtime/install.ts";
import { runtimeDir } from "../runtime/paths.ts";
import type { InstallManifest } from "../runtime/schemas.ts";
import type { InstallProgress } from "../runtime/types.ts";
import { ENGINE_VERSION, engineDir, engineRoot, PROCESSOR_BUILD } from "./engine.ts";
import { LINUX_LOCK, LINUX_WHEEL_BYTES } from "./linux-lock.ts";
import { LINUX_CPU_WHEEL_BYTES, LINUX_LOCK_CPU } from "./linux-lock-cpu.ts";
import type { BuildPlan, EnginePlan } from "./setup.ts";

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
  /** What the built engine takes on disk (its tree, uv, uv's Python, the source), measured once; absent, the setup guesses. */
  diskBytes?: number;
  /**
   * The same engine for a computer whose card cannot run pictures: the lock with torch's CPU build
   * and no CUDA libraries, built into `<version>-cpu`. Absent: that computer builds from `lock`.
   */
  cpu?: { lock: string; wheelBytes: number; diskBytes?: number };
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
  // du of runtime/comfyui, uv, uv-python and comfyui-src after one real build each, 2026-11-14
  diskBytes: 7_325_333_460,
  // compiled 2026-11-14 against the CPU index, the rest held to the cu130 lock's versions
  cpu: { lock: LINUX_LOCK_CPU, wheelBytes: LINUX_CPU_WHEEL_BYTES, diskBytes: 2_444_080_259 },
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
 * download starts and " Downloaded torch" when it ends (uv-command-support progress.rs, 0.13.7):
 * the size, but nothing in between. A wheel counts once it has ended, at the size uv gave it;
 * smaller wheels say nothing and are counted when the sync ends. Never more than `cap`.
 * `inFlight` is what the files uv has started and not ended will add.
 */
export function uvDownloads(cap: number): { line(line: string): number; inFlight(): number } {
  const sizes = new Map<string, number>();
  let done = 0;
  return {
    line(line) {
      const text = line.replace(COLOUR, "").trim();
      const start = /^Downloading (\S+) \((\d+(?:\.\d+)?)(B|KiB|MiB|GiB|TiB)\)$/.exec(text);
      if (start) sizes.set(start[1]!, Math.round(Number(start[2]) * UNITS[start[3]!]!));
      const end = /^Downloaded (\S+)$/.exec(text);
      if (end) { done += sizes.get(end[1]!) ?? 0; sizes.delete(end[1]!); }
      return Math.min(done, cap);
    },
    inFlight: () => [...sizes.values()].reduce((sum, size) => sum + size, 0),
  };
}

/**
 * The bytes this computer's network interfaces have received (/proc/net/dev, loopback left out);
 * undefined where it cannot be read.
 */
export function netReceived(): number | undefined {
  try {
    let sum = 0;
    for (const row of readFileSync("/proc/net/dev", "utf8").split("\n").slice(2)) {
      const [name, rest] = row.split(":");
      if (rest === undefined || name!.trim() === "lo") continue;
      sum += Number(rest.trim().split(/\s+/)[0]);
    }
    return Number.isFinite(sum) ? sum : undefined;
  } catch { return undefined; }
}

/** How often the sync's count is read again while no line comes (a large wheel downloading). */
const COUNT_MS = 500;

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

/**
 * The build with a card's lock, and beside it (`cpu`) the processor one when the pins carry it: the
 * setup takes `cpu` on a computer whose card cannot run pictures (setup.ts), so no CUDA library is
 * fetched there.
 */
export function linuxBuild(opts: { appDataDir: string; pins: LinuxPins; received?: () => number | undefined }): Extract<EnginePlan, { kind: "build" }> {
  const { appDataDir, pins } = opts;
  const received = opts.received ?? netReceived;
  const card = buildWith(appDataDir, pins, received, pins.version, pins.lock, pins.wheelBytes, pins.diskBytes);
  return pins.cpu === undefined ? card : { ...card, cpu: buildWith(appDataDir, pins, received, `${pins.version}${PROCESSOR_BUILD}`, pins.cpu.lock, pins.cpu.wheelBytes, pins.cpu.diskBytes) };
}

function buildWith(appDataDir: string, pins: LinuxPins, received: () => number | undefined, version: string, lockText: string, wheelBytes: number, diskBytes: number | undefined): BuildPlan {
  const bytes = pins.uv.sizeBytes + pins.source.sizeBytes + wheelBytes;
  return {
    kind: "build",
    version,
    bytes,
    ...diskBytes === undefined ? {} : { diskBytes },
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
      // uv's cache is the build's own folder beside the staging one, never kept: kept, it counts as
      // a second engine (6.7 GB by du after one card build) and is one wherever uv can neither
      // clone nor hardlink its files into the venv; a killed build's is swept with its staging above
      const cache = await mkdtemp(path.join(root, `${BUILD_PREFIX}cache-`));
      try {
        await cp(path.join(source.dir, pins.sourceDir), path.join(staging, "ComfyUI"), { recursive: true });
        const lock = path.join(staging, "requirements.lock");
        await writeFile(lock, lockText);
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          UV_CACHE_DIR: cache,
          // uv locks a credentials file before it fetches, by default under the person's home
          // (~/.local/share/uv/credentials); kept in the cache folder, it goes when the build does
          UV_CREDENTIALS_DIR: path.join(cache, "credentials"),
          UV_PYTHON_INSTALL_DIR: path.join(runtimeDir(appDataDir), "uv-python"),
          UV_PYTHON_PREFERENCE: "only-managed",
          UV_NO_CONFIG: "1",
        };
        const venv = path.join(staging, "venv");
        // --relocatable: the venv still runs once the staging folder is renamed into place
        await runUv(path.join(uv.dir, uvBin), ["venv", "--relocatable", "--python", pins.python, venv], env, signal);
        // best-match, as the lock was compiled: first-index would take certifi and the like from
        // the torch index, which lacks the pinned versions
        // The wheels are most of the download. Each one uv says it finished counts; while some are
        // still coming, the bytes the network has received since the sync began count, never past
        // what the wheels uv has started will add, so other downloads on the computer cannot run
        // the count ahead (one real processor build: the finished wheels alone trailed the network
        // by about 0.45 GB of 1.05 for most of the sync, then caught up in its last seconds).
        const wheels = uvDownloads(wheelBytes);
        const rx0 = received();
        let finished = 0, counted = 0;
        const count = () => {
          const rx = rx0 === undefined ? undefined : received();
          const arrived = rx === undefined ? 0 : Math.min(rx - rx0!, finished + wheels.inFlight());
          const now = Math.min(Math.max(finished, arrived, counted), wheelBytes);
          if (now === counted) return;
          counted = now;
          onProgress({ phase: "download", version, receivedBytes: before + now, totalBytes: bytes });
        };
        const timer = setInterval(count, COUNT_MS);
        try {
          await runUv(path.join(uv.dir, uvBin), ["pip", "sync", "--require-hashes", "--index-strategy", "unsafe-best-match", "--python", path.join(venv, "bin", "python"), lock], env, signal, (line) => {
            finished = wheels.line(line);
            count();
          });
        } finally { clearInterval(timer); }
        await access(path.join(venv, "bin", "python"), constants.X_OK);
        await rename(staging, engineDir(appDataDir, version));
        onProgress({ phase: "done", version, receivedBytes: bytes, totalBytes: bytes });
      } finally {
        await rm(staging, { recursive: true, force: true });
        await rm(cache, { recursive: true, force: true });
      }
    },
  };
}
