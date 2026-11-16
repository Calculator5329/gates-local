// external: uv checks the Python it downloads against digests built into the uv binary
import { type ChildProcess, spawn } from "node:child_process";
import { constants, readFileSync } from "node:fs";
import { access, cp, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { installPinned, type InstallTarget } from "../runtime/install.ts";
import { runtimeDir } from "@gates-local/runtime-files/paths";
import type { InstallManifest } from "../runtime/schemas.ts";
import type { InstallProgress } from "../runtime/types.ts";
import { ENGINE_VERSION, engineDir, engineRoot, PROCESSOR_BUILD } from "./engine.ts";
import { LINUX_LOCK, LINUX_WHEEL_BYTES } from "./linux-lock.ts";
import { LINUX_CPU_WHEEL_BYTES, LINUX_LOCK_CPU } from "./linux-lock-cpu.ts";
import type { BuildPlan, EnginePlan } from "./setup.ts";

export type LinuxPins = {
  version: string;
  python: string;
  uv: InstallManifest;
  uvDir: string;
  source: InstallManifest;
  sourceDir: string;
  lock: string;
  wheelBytes: number;
  diskBytes?: number;
  cpu?: { lock: string; wheelBytes: number; diskBytes?: number };
};

// external: uv's GitHub releases publish a sha256 digest and size for each asset
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
  // why: measured by du over the four runtime folders after one real build on 2026-11-14
  diskBytes: 7_325_333_460,
  cpu: { lock: LINUX_LOCK_CPU, wheelBytes: LINUX_CPU_WHEEL_BYTES, diskBytes: 2_444_080_259 },
};

export const linuxPinned = (pins: LinuxPins): boolean => pins.uv.verified && pins.source.verified && pins.lock !== "";

const BUILD_PREFIX = ".build-";

const target = (appDataDir: string, label: string, folder: string, inside: string): InstallTarget => ({
  label, name: `the ${label}`,
  root: path.join(runtimeDir(appDataDir), folder),
  stagingRoot: path.join(runtimeDir(appDataDir), folder),
  check: (tree) => access(path.join(tree, inside), constants.R_OK),
});

const UNITS: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };
// external: uv prints ANSI colour codes even into a pipe when FORCE_COLOR is set
const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

// external: off a terminal, uv 0.13.7 logs files over 1 MiB only at start (with size) and end
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

// external: /proc/net/dev has two header lines, then one "name: rx_bytes ..." row per interface
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

const COUNT_MS = 500;

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
      for (const entry of await readdir(root)) if (entry.startsWith(BUILD_PREFIX)) await rm(path.join(root, entry), { recursive: true, force: true });
      const staging = await mkdtemp(path.join(root, BUILD_PREFIX));
      // why: a kept uv cache is a second engine on disk, 6.7 GB after one card build
      const cache = await mkdtemp(path.join(root, `${BUILD_PREFIX}cache-`));
      try {
        await cp(path.join(source.dir, pins.sourceDir), path.join(staging, "ComfyUI"), { recursive: true });
        const lock = path.join(staging, "requirements.lock");
        await writeFile(lock, lockText);
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          UV_CACHE_DIR: cache,
          // external: by default uv locks a credentials file in the person's home before fetching
          UV_CREDENTIALS_DIR: path.join(cache, "credentials"),
          UV_PYTHON_INSTALL_DIR: path.join(runtimeDir(appDataDir), "uv-python"),
          UV_PYTHON_PREFERENCE: "only-managed",
          UV_NO_CONFIG: "1",
        };
        const venv = path.join(staging, "venv");
        // external: uv venv --relocatable makes a venv that still runs after its folder is moved
        await runUv(path.join(uv.dir, uvBin), ["venv", "--relocatable", "--python", pins.python, venv], env, signal);
        // external: uv's default takes certifi from the torch index, which lacks the pinned version
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
