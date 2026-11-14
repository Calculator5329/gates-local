// The app's own image engine: a pinned ComfyUI release in
// <appData>/runtime/comfyui/<version>/, fetched by the same installer as
// Ollama (pinned URL, sha256 checked while streaming, staged and renamed in
// one step). Nothing system-wide, no admin, no service.
//
// Two layouts. Windows: the release's portable 7z (embedded Python, torch,
// ComfyUI). Linux has no portable, so the tree is built from uv, its
// standalone Python and ComfyUI's source (linux-build.ts). Both start the
// same way: that Python running ComfyUI/main.py.
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import * as Schema from "effect/Schema";
import { installPinned, type InstallResult, type InstallTarget } from "../runtime/install.ts";
import { runtimeDir } from "../runtime/paths.ts";
import { decode, InstallManifest, parseJson } from "../runtime/schemas.ts";
import type { InstallProgress } from "../runtime/types.ts";

/** windows-portable: the release 7z. uv-venv: the Linux tree (venv/ beside ComfyUI/). */
export type EngineLayout = "windows-portable" | "uv-venv";

/** The ComfyUI release the app pins. Bump with every manifest below. */
export const ENGINE_VERSION = "0.44.0";
const RELEASE = `https://github.com/Comfy-Org/ComfyUI/releases/download/v${ENGINE_VERSION}`;

/**
 * Windows x64, NVIDIA RTX 20-series and newer: the v0.44.0 portable with
 * embedded Python 3.13 and torch cu130. The sha256 and the exact size are the
 * release API's asset `digest` and `size` (read 2026-11-13, no download).
 */
export const PINNED_ENGINE_WINDOWS: InstallManifest = {
  version: ENGINE_VERSION,
  url: `${RELEASE}/ComfyUI_windows_portable_nvidia.7z`,
  sha256: "7170c2db49c182a81adcc051e80234f99dd891656fb200737f87797876348f96",
  sizeBytes: 2_054_382_457,
  format: "7z",
  verified: true,
  source: "GitHub release API asset digest and size, read 2026-11-13",
};

/** The same release's build for GTX 10-series and older cards (torch cu126; CUDA 13 dropped them), pinned the same way. */
export const PINNED_ENGINE_WINDOWS_CU126: InstallManifest = {
  version: `${ENGINE_VERSION}-cu126`,
  url: `${RELEASE}/ComfyUI_windows_portable_nvidia_cu126.7z`,
  sha256: "a26cf84f043b3d9fbf0d53296f57d7190482c339caf1b3b5cfda5149d454be9f",
  sizeBytes: 1_945_636_677,
  format: "7z",
  verified: true,
  source: "GitHub release API asset digest and size, read 2026-11-13",
};

/**
 * Whether a release offers Set up images with the pinned engine. Off until step 5 (one real
 * install of the pinned engine and the first model, on a real machine) has run once; the pop-up
 * then says the app cannot set images up here, as on a computer it has no engine for. Tests'
 * fake engine (GATES_LOCAL_IMAGE_ENGINE) is offered whatever this says.
 */
export const ENGINE_OFFERED = false;

/**
 * Set up images with the real pinned engine: ENGINE_OFFERED, or GATES_LOCAL_OFFER_ENGINE=1 for a
 * person who chooses to try the real install before a release offers it (step 5). Any other
 * non-empty value is an error at startup.
 */
export function engineOffered(text: string | undefined): boolean {
  if (text === undefined || text === "") return ENGINE_OFFERED;
  if (text === "1") return true;
  throw new Error(`GATES_LOCAL_OFFER_ENGINE must be unset or "1", got "${text}"`);
}

/** Cards CUDA 13 no longer runs: Pascal and older (GTX 10-series, TITAN X/Xp, Quadro P, Tesla P). */
const OLD_CARD = /\b(GTX\s?(9|10)\d0|TITAN X|Quadro [MP]\d|Tesla [KMP]\d)/i;

/**
 * The engine this machine would install, or undefined where the app has none
 * (macOS, ARM, Linux until its build is pinned). `gpuName` is nvidia-smi's.
 */
export function engineFor(platform: NodeJS.Platform, arch: string, gpuName?: string): { manifest: InstallManifest; layout: EngineLayout } | undefined {
  if (arch !== "x64") return undefined;
  if (platform === "win32") return { manifest: gpuName !== undefined && OLD_CARD.test(gpuName) ? PINNED_ENGINE_WINDOWS_CU126 : PINNED_ENGINE_WINDOWS, layout: "windows-portable" };
  return undefined;
}

export function engineRoot(appDataDir: string): string {
  return path.join(runtimeDir(appDataDir), "comfyui");
}

export function engineDir(appDataDir: string, version: string): string {
  return path.join(engineRoot(appDataDir), version);
}

/** The Python that runs ComfyUI, and ComfyUI's main.py, inside an engine tree. */
export function engineFiles(dir: string, layout: EngineLayout): { python: string; main: string; cwd: string } {
  if (layout === "windows-portable") {
    const top = path.join(dir, "ComfyUI_windows_portable");
    return { python: path.join(top, "python_embeded", "python.exe"), main: path.join(top, "ComfyUI", "main.py"), cwd: top };
  }
  return { python: path.join(dir, "venv", "bin", "python"), main: path.join(dir, "ComfyUI", "main.py"), cwd: dir };
}

export function engineTarget(appDataDir: string, layout: EngineLayout): InstallTarget {
  const files = (tree: string) => engineFiles(tree, layout);
  return {
    label: "image engine",
    name: "the image engine",
    root: engineRoot(appDataDir),
    stagingRoot: engineRoot(appDataDir),
    check: async (tree) => {
      await access(files(tree).python, layout === "windows-portable" ? constants.F_OK : constants.X_OK);
      await access(files(tree).main, constants.R_OK);
    },
  };
}

export type EngineInstallOptions = {
  appDataDir: string;
  manifest: InstallManifest;
  layout: EngineLayout;
  onProgress?: (p: InstallProgress) => void;
  signal?: AbortSignal;
  progressIntervalMs?: number;
};

/** linux-build.ts's pins, for a test that builds its fake engine the way Linux does (uv and a lock). */
const BuildKnob = Schema.Struct({
  version: Schema.String, python: Schema.String, uv: InstallManifest, uvDir: Schema.String,
  source: InstallManifest, sourceDir: Schema.String, lock: Schema.String, wheelBytes: Schema.Number,
});
const EngineKnob = Schema.Struct({ manifest: InstallManifest, layout: Schema.Literals(["windows-portable", "uv-venv"]), address: Schema.String, build: Schema.optional(BuildKnob) });
export type EngineKnob = typeof EngineKnob.Type;

/**
 * GATES_LOCAL_IMAGE_ENGINE (tests only): the engine to install in place of the pinned one, and the
 * address the app's own ComfyUI is read at (the e2e stack's fake). Undefined when unset; a
 * malformed value is an error, never a silent fallback to the real download.
 */
export function engineKnob(text: string | undefined): EngineKnob | undefined {
  if (text === undefined || text === "") return undefined;
  const json = parseJson(text);
  if (!json.ok) throw new Error("GATES_LOCAL_IMAGE_ENGINE is not JSON");
  const knob = decode(EngineKnob, json.value);
  if (!knob.ok) throw new Error(`GATES_LOCAL_IMAGE_ENGINE: ${knob.message}`);
  return knob.value;
}

/** Install a pinned engine archive unless that version is already in place. */
export function installEngine(opts: EngineInstallOptions): Promise<InstallResult> {
  const { layout, ...rest } = opts;
  return installPinned({ ...rest, target: engineTarget(opts.appDataDir, layout) });
}
