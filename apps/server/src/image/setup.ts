// Set up images (row 12's pop-up, then one sheet): the app's own ComfyUI
// (engine.ts, the same pinned installer as Ollama) and the recommended setup
// for this card (row 11's default), as one download. Nothing is fetched
// without the click; where images cannot run, image.setupInfo says why in one
// sentence and offers nothing.
import { statfs } from "node:fs/promises";
import path from "node:path";
import type { GpuStatus, ImageSetup, ImageSetupProgress } from "@gates-local/contracts";
import type { InstallProgress } from "../runtime/types.ts";
import { installEngine, type EngineLayout } from "./engine.ts";
import type { ImageModule } from "./module.ts";
import type { OwnComfy } from "./own.ts";
import { MIN_ROOM, PRESETS, presetFiles } from "./presets.ts";
import type { InstallManifest } from "../runtime/schemas.ts";

const GIB = 1024 ** 3;
const gb = (bytes: number) => `${(bytes / GIB).toFixed(1)} GB`;
const ELSEWHERE = "A ComfyUI on another computer works too: set its address in Settings.";

export const NO_ENGINE = "The app cannot set up images on this computer. A ComfyUI you run yourself works: set its address in Settings.";
export const addressSet = (address: string) => `Settings names a ComfyUI at ${address}, and it did not answer. Start it there, or clear the address in Settings so the app can set images up here.`;

/**
 * The one recommended download on every tier (row 11's bench, 2026-11-13): Klein 4B with the FP4
 * encoder, 8.26 GB. It won every cell at 8 GiB and under, and is the CPU cells' model. The full
 * encoder and MOSS-Image are a second download where they won, offered in the picker, never here.
 */
export const SETUP_PRESET = "flux2-klein-4b-compact";

/**
 * With no graphics card for pictures, the same engine runs on the processor. Measured on the basic
 * PC bench (i5-8500, Klein FP4, 2 to 4 steps): 100 to 235 s a picture. The sheet says so before
 * anything downloads.
 */
export const CPU_SECONDS = { low: 100, high: 235 } as const;
export const GPU_UNREAD = `The app could not read this computer's graphics card, so it cannot tell whether pictures can run here. ${ELSEWHERE}`;
/** `room` is the held engine value's (imageRoom: the card to the nearest GB). */
export const smallCard = (room: number) => `This graphics card has ${Math.round(room / GIB)} GB; Image mode needs 4 GB. ${ELSEWHERE}`;
export const shortDisk = (need: number, free: number) => `Needs ${gb(need)} free; ${gb(free)} is free on this drive.`;

/**
 * The disk the engine takes against its download: the archive while it unpacks, plus the unpacked
 * tree, which a 7z of Python wheels holds several times over. A guess with room to spare until the
 * first real install measures it.
 */
const UNPACK_FACTOR = 4;

/** How this machine's engine is fetched: one pinned archive (Windows, and the e2e fake), or the Linux build (linux-build.ts). */
export type EnginePlan =
  | { kind: "archive"; manifest: InstallManifest; layout: EngineLayout }
  | { kind: "build"; version: string; bytes: number; run(onProgress: (p: InstallProgress) => void, signal: AbortSignal): Promise<void> };

export interface ImageSetupDeps {
  appDataDir: string;
  own: Pick<OwnComfy, "installed">;
  image: Pick<ImageModule, "status" | "engine" | "start" | "download">;
  /** Records the device the engine runs on (own.ts reads it at start): "cpu" when the card cannot. */
  setDevice(device: "gpu" | "cpu"): void;
  /** The engine this machine would fetch (engineFor, or the e2e knob's), or undefined where there is none. */
  engine(gpuName: string | undefined): EnginePlan | undefined;
  gpuStatus(): Promise<GpuStatus>;
  /** Settings' ComfyUI address: while one is set, the app reads it and not its own engine, so there is nothing to set up. */
  settingsAddress(): string | undefined;
  /** Settings' picked folder for image downloads: the model goes there, not the app's drive (the download checks that drive itself). */
  pickedFolder?(): string | undefined;
  push(channel: "image.setup", payload: ImageSetupProgress): void;
  freeBytes?(dir: string): Promise<number>;
  log?(line: string): void;
}

export interface ImageSetupModule {
  info(): Promise<ImageSetup>;
  run(): Promise<{ started: boolean }>;
  /** Every push the image module makes passes here first: the model step follows image.download. */
  saw(channel: string, payload: unknown): void;
}

/** Free space on the drive that holds `dir`, from its nearest existing folder. */
async function diskFree(dir: string): Promise<number> {
  for (let at = dir; ; at = path.dirname(at)) {
    try { const s = await statfs(at); return s.bavail * s.bsize; }
    catch (error) { if (path.dirname(at) === at) throw error; }
  }
}

const planBytes = (plan: EnginePlan) => plan.kind === "archive" ? plan.manifest.sizeBytes : plan.bytes;
const planVersion = (plan: EnginePlan) => plan.kind === "archive" ? plan.manifest.version : plan.version;

/** The setup's download: every file its workflow loads, at the sizes the app's records give. */
function modelBytes(presetId: string): number {
  const preset = PRESETS.find((p) => p.id === presetId)!;
  return presetFiles(preset).reduce((sum, file) => sum + (preset.sources?.[file]?.bytes ?? 0), 0);
}

export function createImageSetup(deps: ImageSetupDeps): ImageSetupModule {
  const log = deps.log ?? (() => {});
  let last: ImageSetupProgress | undefined;
  let running: Promise<void> | undefined;
  /** The model step, while it runs: its setup, the bytes before it, and the whole run's. */
  let model: { preset: string; before: number; bytes: number; total: number; end(ended: { ok: boolean; message?: string }): void } | undefined;
  const say = (p: ImageSetupProgress) => { last = p; deps.push("image.setup", p); };

  const read = async (): Promise<{ info: ImageSetup; plan?: EnginePlan; cpu?: boolean }> => {
    // The card's name only, for the build the engine needs (engineFor: older cards take cu126).
    const gpu = await deps.gpuStatus().catch(() => undefined);
    const plan = deps.engine(gpu?.name);
    const progress = last === undefined ? {} : { progress: last };
    const set = deps.settingsAddress();
    if (set !== undefined) return { info: { why: addressSet(set), ...progress } };
    if (plan === undefined) return { info: { why: NO_ENGINE, ...progress } };
    // Whether pictures run here, and on what, is the image module's held value; it is not worked out again here.
    await deps.image.status().catch(() => undefined);
    const { room } = deps.image.engine();
    if (room === undefined) return { info: { why: GPU_UNREAD, ...progress } };
    if (room > 0 && room < MIN_ROOM) return { info: { why: smallCard(room), ...progress } };
    const cpu = room === 0;
    const preset = PRESETS.find((p) => p.id === SETUP_PRESET)!;
    const installed = deps.own.installed();
    const engineBytes = planBytes(plan);
    const bytes = modelBytes(preset.id);
    const freeBytes = await (deps.freeBytes ?? diskFree)(deps.appDataDir).catch(() => undefined);
    return {
      plan, cpu,
      info: {
        engine: { version: planVersion(plan), bytes: engineBytes, installed },
        model: { preset: preset.id, name: preset.name, bytes },
        ...cpu ? { cpu: CPU_SECONDS } : {},
        ...freeBytes === undefined ? {} : { freeBytes },
        needBytes: (installed ? 0 : engineBytes * UNPACK_FACTOR) + (deps.pickedFolder?.() === undefined ? bytes : 0),
        ...progress,
      },
    };
  };

  return {
    info: async () => (await read()).info,
    async run() {
      if (running !== undefined) return { started: false };
      const { info, plan, cpu } = await read();
      const preset = SETUP_PRESET;
      if (info.why !== undefined || plan === undefined) throw Object.assign(new Error(info.why ?? NO_ENGINE), { code: "image-setup" });
      if (info.freeBytes !== undefined && info.needBytes !== undefined && info.freeBytes < info.needBytes) throw Object.assign(new Error(shortDisk(info.needBytes, info.freeBytes)), { code: "image-setup" });
      const engineBytes = info.engine!.installed ? 0 : info.engine!.bytes;
      const total = engineBytes + info.model!.bytes;
      const controller = new AbortController();
      say({ step: "engine", completedBytes: 0, totalBytes: total });
      running = (async () => {
        if (!deps.own.installed()) {
          const onProgress = (p: InstallProgress) => say({ step: "engine", completedBytes: Math.min(p.receivedBytes, engineBytes), totalBytes: total });
          if (plan.kind === "archive") await installEngine({ appDataDir: deps.appDataDir, manifest: plan.manifest, layout: plan.layout, onProgress, signal: controller.signal });
          else await plan.run(onProgress, controller.signal);
        }
        deps.setDevice(cpu === true ? "cpu" : "gpu");
        // The model is fetched with the engine stopped (a download never needs it), then the engine
        // starts once, to read what it has; its idle stop ends it.
        let end!: (ended: { ok: boolean; message?: string }) => void;
        const ended = new Promise<{ ok: boolean; message?: string }>((resolve) => { end = resolve; });
        model = { preset, before: engineBytes, bytes: info.model!.bytes, total, end };
        say({ step: "model", completedBytes: engineBytes, totalBytes: total });
        const { files } = await deps.image.download(preset);
        const result = files.length === 0 ? { ok: true } : await ended;
        model = undefined;
        if (!result.ok) throw new Error(result.message ?? "The model download stopped.");
        say({ step: "starting", completedBytes: total, totalBytes: total });
        await deps.image.start();
        say({ step: "done", completedBytes: total, totalBytes: total });
      })().catch((error: unknown) => {
        model = undefined;
        const message = error instanceof Error ? error.message : String(error);
        log(`setup failed: ${message}`);
        say({ step: "error", completedBytes: last?.completedBytes ?? 0, totalBytes: total, message });
      }).finally(() => { running = undefined; });
      return { started: true };
    },
    saw(channel, payload) {
      if (channel !== "image.download" || model === undefined) return;
      const p = payload as { preset: string; file: number; files: number; state: string; completedBytes: number; totalBytes?: number; setupCompletedBytes?: number; setupTotalBytes?: number; ended?: boolean; message?: string };
      if (p.preset !== model.preset) return;
      const share = p.setupTotalBytes !== undefined && p.setupTotalBytes > 0 && p.setupCompletedBytes !== undefined
        ? p.setupCompletedBytes / p.setupTotalBytes
        : (p.file - 1 + (p.totalBytes ? p.completedBytes / p.totalBytes : 0)) / p.files;
      const completedBytes = model.before + Math.round(Math.min(1, share) * model.bytes);
      const { total } = model;
      // the run says what follows the download's end: the engine's start, or the error
      if (p.ended === true) {
        if (p.state !== "done") say({ step: "model", completedBytes, totalBytes: total });
        model.end({ ok: p.state === "done", ...p.message === undefined ? {} : { message: p.message } });
        model = undefined;
      } else say({ step: "model", completedBytes, totalBytes: total });
    },
  };
}
