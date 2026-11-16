// why: the engine reuses Ollama's pinned installer, so the app has one install path, not two
import { statfs } from "node:fs/promises";
import path from "node:path";
import { cardBytes, type GpuStatus, type ImageSetup, type ImageSetupProgress } from "@gates-local/contracts";
import { shortDisk } from "../runtime/install.ts";
import type { InstallProgress } from "../runtime/types.ts";
import { installEngine, isProcessorBuild, type EngineLayout } from "./engine.ts";
import type { ImageModule } from "./module.ts";
import type { OwnComfy } from "./own.ts";
import { MIN_ROOM, PRESETS, presetFiles } from "./presets.ts";
import type { InstallManifest } from "../runtime/schemas.ts";

const GIB = 1024 ** 3;
const ELSEWHERE = "A ComfyUI on another computer works too: set its address in Settings.";

export const NO_ENGINE = "The app cannot set up images on this computer. A ComfyUI you run yourself works: set its address in Settings.";
export const NOT_YET = "Picture setup is not in this version yet. A ComfyUI you run yourself works: set its address in Settings.";
export const CARD_NOT_STARTED = "The picture engine for the graphics card stopped while it was starting, so pictures still run on the processor. Its log says why.";
export const addressSet = (address: string) => `Settings names a ComfyUI at ${address}, and it did not answer. Start it there, or clear the address in Settings so the app can set images up here.`;

// why: Klein 4B with the FP4 encoder won every bench cell at 8 GiB and under, and every CPU cell
export const SETUP_PRESET = "flux2-klein-4b-compact";

// why: measured on the basic-PC bench, an i5-8500 running Klein FP4 at 2 to 4 steps
export const CPU_SECONDS = { low: 100, high: 235 } as const;
export const GPU_UNREAD = `The app could not read this computer's graphics card, so it cannot tell whether pictures can run here. ${ELSEWHERE}`;
export const smallCard = (room: number) => `This graphics card has ${Math.round(room / GIB)} GB; Image mode needs 4 GB. ${ELSEWHERE}`;

// why: a 7z of Python wheels unpacks to several times its size, so this is a padded guess
const UNPACK_FACTOR = 4;

// why: one processor build needed 0.17 GB beyond its tree, and the card build's was not measured
export const BUILD_MARGIN = 1024 ** 3;

export type BuildPlan = { kind: "build"; version: string; bytes: number; diskBytes?: number; run(onProgress: (p: InstallProgress) => void, signal: AbortSignal): Promise<void> };

export type EnginePlan =
  | { kind: "archive"; manifest: InstallManifest; layout: EngineLayout }
  | BuildPlan & { cpu?: BuildPlan };

export const planFor = (plan: EnginePlan, cpu: boolean): EnginePlan => cpu && plan.kind === "build" && plan.cpu !== undefined ? plan.cpu : plan;

export interface ImageSetupDeps {
  appDataDir: string;
  own: Pick<OwnComfy, "installed" | "build" | "holdCard" | "heldCard" | "failedCard" | "tryCard" | "onHeld">;
  image: Pick<ImageModule, "status" | "engine" | "start" | "download"> & Partial<Pick<ImageModule, "stopIdle" | "setupLeft">>;
  setDevice(device: "gpu" | "cpu"): void;
  engine(gpuName: string | undefined): EnginePlan | "later" | undefined;
  gpuStatus(): Promise<GpuStatus>;
  settingsAddress(): string | undefined;
  pickedFolder?(): string | undefined;
  push(channel: "image.setup", payload: ImageSetupProgress): void;
  freeBytes?(dir: string): Promise<number>;
  log?(line: string): void;
}

export interface ImageSetupModule {
  info(): Promise<ImageSetup>;
  run(): Promise<{ started: boolean }>;
  saw(channel: string, payload: unknown): void;
}

async function diskFree(dir: string): Promise<number> {
  for (let at = dir; ; at = path.dirname(at)) {
    try { const s = await statfs(at); return s.bavail * s.bsize; }
    catch (error) { if (path.dirname(at) === at) throw error; }
  }
}

const planBytes = (plan: EnginePlan) => plan.kind === "archive" ? plan.manifest.sizeBytes : plan.bytes;
const planDisk = (plan: EnginePlan) => plan.kind === "build" && plan.diskBytes !== undefined ? plan.diskBytes + BUILD_MARGIN : planBytes(plan) * UNPACK_FACTOR;
const planVersion =(plan: EnginePlan) => plan.kind === "archive" ? plan.manifest.version : plan.version;

function modelBytes(presetId: string): number {
  const preset = PRESETS.find((p) => p.id === presetId)!;
  return presetFiles(preset).reduce((sum, file) => sum + (preset.sources?.[file]?.bytes ?? 0), 0);
}

const runsPictures = (gpu: GpuStatus | undefined) => gpu?.vendor === "nvidia" && gpu.totalBytes !== undefined && cardBytes(gpu.totalBytes) >= MIN_ROOM;

export function createImageSetup(deps: ImageSetupDeps): ImageSetupModule {
  const log = deps.log ?? (() => {});
  let last: ImageSetupProgress | undefined;
  let toCardRun = false;
  // external: a CUDA ComfyUI build with no usable card does not start unless given --cpu
  const follow = (gpu: GpuStatus | undefined) => {
    if (!deps.own.installed()) return;
    if (gpu?.vendor === "none") deps.setDevice("cpu");
    else if (runsPictures(gpu)) deps.setDevice("gpu");
  };
  let running: Promise<{ started: true }> | undefined;
  let model: { preset: string; before: number; bytes: number; total: number; end(ended: { ok: boolean; message?: string }): void } | undefined;
  const say = (p: ImageSetupProgress) => {
    const said: ImageSetupProgress = toCardRun ? { ...p, toCard: true } : p;
    last = said;
    deps.push("image.setup", said);
  };

  const read = async (): Promise<{ info: ImageSetup; plan?: EnginePlan; cpu?: boolean; toCard?: boolean }> => {
    const gpu = await deps.gpuStatus().catch(() => undefined);
    try { follow(gpu); } catch (error) { log(`device not recorded: ${error instanceof Error ? error.message : String(error)}`); }
    const found = deps.engine(gpu?.name);
    const said = last ?? (deps.own.failedCard?.() === undefined ? undefined : { step: "error" as const, completedBytes: 0, totalBytes: 0, message: CARD_NOT_STARTED, toCard: true as const });
    const progress = said === undefined ? {} : { progress: said };
    const set = deps.settingsAddress();
    if (set !== undefined) return { info: { why: addressSet(set), ...progress } };
    if (found === "later") return { info: { why: NOT_YET, ...progress } };
    if (found === undefined) return { info: { why: NO_ENGINE, ...progress } };
    // why: setup reads the image module's held value, so the two never disagree about the card
    await deps.image.status().catch(() => undefined);
    const { room } = deps.image.engine();
    if (room === undefined) return { info: { why: GPU_UNREAD, ...progress } };
    if (room > 0 && room < MIN_ROOM) return { info: { why: smallCard(room), ...progress } };
    // why: room is 0 for the processor build whatever card is there, so nvidia-smi says if one is
    const built = deps.own.build?.();
    const toCard = built !== undefined && isProcessorBuild(built.version) && runsPictures(gpu) && found.kind === "build" && found.cpu !== undefined;
    const cpu = room === 0 && !toCard;
    const plan = planFor(found, cpu);
    const preset = PRESETS.find((p) => p.id === SETUP_PRESET)!;
    const installed = toCard ? deps.own.heldCard?.() === planVersion(plan) : deps.own.installed();
    const engineBytes = planBytes(plan);
    const bytes = await deps.image.setupLeft?.(preset.id).catch(() => undefined) ?? modelBytes(preset.id);
    const freeBytes = await (deps.freeBytes ?? diskFree)(deps.appDataDir).catch(() => undefined);
    return {
      plan, cpu, toCard,
      info: {
        engine: { version: installed && !toCard && built !== undefined ? built.version : planVersion(plan), bytes: engineBytes, installed },
        ...toCard ? { toCard: true as const } : {},
        model: { preset: preset.id, name: preset.name, bytes },
        ...cpu ? { cpu: CPU_SECONDS } : {},
        ...freeBytes === undefined ? {} : { freeBytes },
        needBytes: (installed ? 0 : planDisk(plan)) +(deps.pickedFolder?.() === undefined ? bytes : 0),
        ...progress,
      },
    };
  };

  deps.own.onHeld?.(() => {
    if (running === undefined) say({ step: "error", completedBytes: 0, totalBytes: 0, message: CARD_NOT_STARTED, toCard: true });
  });

  void deps.gpuStatus().then(follow).catch((error: unknown) => log(`device not checked: ${error instanceof Error ? error.message : String(error)}`));

  return {
    info: async () => (await read()).info,
    run() {
      if (running !== undefined) return running;
      const run = begin();
      running = run;
      run.catch(() => { if (running === run) running = undefined; });
      return run;
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
      if (p.ended === true) {
        if (p.state !== "done") say({ step: "model", completedBytes, totalBytes: total });
        model.end({ ok: p.state === "done", ...p.message === undefined ? {} : { message: p.message } });
        model = undefined;
      } else say({ step: "model", completedBytes, totalBytes: total });
    },
  };

  async function begin(): Promise<{ started: true }> {
    const { info, plan, cpu, toCard } = await read();
    const preset = SETUP_PRESET;
    if (info.why !== undefined || plan === undefined) throw Object.assign(new Error(info.why ?? NO_ENGINE), { code: "image-setup" });
    if (info.freeBytes !== undefined && info.needBytes !== undefined && info.freeBytes < info.needBytes) throw Object.assign(new Error(shortDisk(info.needBytes, info.freeBytes)), { code: "image-setup" });
    const engineBytes = info.engine!.installed ? 0 : info.engine!.bytes;
    const total = engineBytes + info.model!.bytes;
    const controller = new AbortController();
    toCardRun = toCard === true;
    say({ step: "engine", completedBytes: 0, totalBytes: total });
    const mine = running;
    void (async () => {
      if (toCard === true) deps.own.holdCard?.(planVersion(plan));
      if (toCard === true ? !info.engine!.installed : !deps.own.installed()) {
        const onProgress = (p: InstallProgress) => say({ step: "engine", completedBytes: Math.min(p.receivedBytes, engineBytes), totalBytes: total });
        if (plan.kind === "archive") await installEngine({ appDataDir: deps.appDataDir, manifest: plan.manifest, layout: plan.layout, onProgress, signal: controller.signal });
        else await plan.run(onProgress, controller.signal);
      }
      deps.setDevice(cpu === true ? "cpu" : "gpu");
      // why: a model download never needs the engine, so it starts once after, to read the files
      let end!: (ended: { ok: boolean; message?: string }) => void;
      const ended = new Promise<{ ok: boolean; message?: string }>((resolve) => { end = resolve; });
      model = { preset, before: engineBytes, bytes: info.model!.bytes, total, end };
      say({ step: "model", completedBytes: engineBytes, totalBytes: total });
      const { files } = await deps.image.download(preset);
      const result = files.length === 0 ? { ok: true } : await ended;
      model = undefined;
      if (!result.ok) throw new Error(result.message ?? "The model download stopped.");
      say({ step: "starting", completedBytes: total, totalBytes: total });
      if (toCard === true) {
        await deps.image.stopIdle?.().catch((error: unknown) => log(`the processor engine was not stopped: ${error instanceof Error ? error.message : String(error)}`));
        deps.own.tryCard?.();
      }
      await deps.image.start();
      const runs = deps.own.build?.();
      if (toCard === true && runs !== undefined && isProcessorBuild(runs.version)) throw new Error(CARD_NOT_STARTED);
      say({ step: "done", completedBytes: total, totalBytes: total });
    })().catch((error: unknown) => {
      model = undefined;
      const message = error instanceof Error ? error.message : String(error);
      log(`setup failed: ${message}`);
      say({ step: "error", completedBytes: last?.completedBytes ?? 0, totalBytes: total, message });
    }).finally(() => { toCardRun = false; if (running === mine) running = undefined; });
    return { started: true };
  }
}
