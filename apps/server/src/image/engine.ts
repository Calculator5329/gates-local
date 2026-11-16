// external: ComfyUI ships a portable 7z for Windows only, none for Linux
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import * as Schema from "effect/Schema";
import { installPinned, type InstallResult, type InstallTarget } from "../runtime/install.ts";
import { runtimeDir } from "@gates-local/runtime-files/paths";
import { decode, InstallManifest, parseJson } from "../runtime/schemas.ts";
import type { InstallProgress } from "../runtime/types.ts";

export type EngineLayout = "windows-portable" | "uv-venv";

// why: the manifests' URLs come from this version, so a bump needs each digest and size read again
export const ENGINE_VERSION = "0.44.0";
const RELEASE = `https://github.com/Comfy-Org/ComfyUI/releases/download/v${ENGINE_VERSION}`;

// external: the v0.44.0 Windows portable bundles Python 3.13 and torch cu130, for RTX 20-series up
export const PINNED_ENGINE_WINDOWS: InstallManifest = {
  version: ENGINE_VERSION,
  url: `${RELEASE}/ComfyUI_windows_portable_nvidia.7z`,
  sha256: "7170c2db49c182a81adcc051e80234f99dd891656fb200737f87797876348f96",
  sizeBytes: 2_054_382_457,
  format: "7z",
  verified: true,
  source: "GitHub release API asset digest and size, read 2026-11-13",
};

// external: ComfyUI v0.44.0 also ships a cu126 portable for the older cards CUDA 13 dropped
export const PINNED_ENGINE_WINDOWS_CU126: InstallManifest = {
  version: `${ENGINE_VERSION}-cu126`,
  url: `${RELEASE}/ComfyUI_windows_portable_nvidia_cu126.7z`,
  sha256: "a26cf84f043b3d9fbf0d53296f57d7190482c339caf1b3b5cfda5149d454be9f",
  sizeBytes: 1_945_636_677,
  format: "7z",
  verified: true,
  source: "GitHub release API asset digest and size, read 2026-11-13",
};

export const ENGINE_OFFERED = false;

export function engineOffered(text: string | undefined): boolean {
  if (text === undefined || text === "") return ENGINE_OFFERED;
  if (text === "1") return true;
  throw new Error(`GATES_LOCAL_OFFER_ENGINE must be unset or "1", got "${text}"`);
}

// external: CUDA 13 dropped Pascal and older cards (GTX 10-series, TITAN X/Xp, Quadro P, Tesla P)
const OLD_CARD = /\b(GTX\s?(9|10)\d0|TITAN X|Quadro [MP]\d|Tesla [KMP]\d)/i;

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

export const PROCESSOR_BUILD = "-cpu";
export const isProcessorBuild = (version: string) => version.endsWith(PROCESSOR_BUILD);

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

const BuildKnob = Schema.Struct({
  version: Schema.String, python: Schema.String, uv: InstallManifest, uvDir: Schema.String,
  source: InstallManifest, sourceDir: Schema.String, lock: Schema.String, wheelBytes: Schema.Number,
  cpu: Schema.optional(Schema.Struct({ lock: Schema.String, wheelBytes: Schema.Number })),
});
const EngineKnob = Schema.Struct({ manifest: InstallManifest, layout: Schema.Literals(["windows-portable", "uv-venv"]), address: Schema.String, build: Schema.optional(BuildKnob) });
export type EngineKnob = typeof EngineKnob.Type;

export function engineKnob(text: string | undefined): EngineKnob | undefined {
  if (text === undefined || text === "") return undefined;
  const json = parseJson(text);
  if (!json.ok) throw new Error("GATES_LOCAL_IMAGE_ENGINE is not JSON");
  const knob = decode(EngineKnob, json.value);
  if (!knob.ok) throw new Error(`GATES_LOCAL_IMAGE_ENGINE: ${knob.message}`);
  return knob.value;
}

export function installEngine(opts: EngineInstallOptions): Promise<InstallResult> {
  const { layout, ...rest } = opts;
  return installPinned({ ...rest, target: engineTarget(opts.appDataDir, layout) });
}
