// Set up images (row 12's pop-up, then one sheet): the app's own ComfyUI
// (engine.ts, the same pinned installer as Ollama) and the recommended setup
// for this card (row 11's default), as one download. Nothing is fetched
// without the click; where images cannot run, image.setupInfo says why in one
// sentence and offers nothing.
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
/** A computer the app sets images up on, in a release that does not offer it yet (engine.ts ENGINE_OFFERED): the version, not the computer. */
export const NOT_YET = "Picture setup is not in this version yet. A ComfyUI you run yourself works: set its address in Settings.";
/** The card's engine was not there after its start, and the processor's build runs in its place. */
export const CARD_NOT_STARTED = "The picture engine for the graphics card stopped while it was starting, so pictures still run on the processor. Its log says why.";
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

/**
 * The disk the engine takes against its download: the archive while it unpacks, plus the unpacked
 * tree, which a 7z of Python wheels holds several times over. A guess with room to spare until the
 * first real install measures it.
 */
const UNPACK_FACTOR = 4;

/**
 * Room beside a build's measured tree for what the measure leaves out: uv's cache while the build
 * runs, the two archives while they unpack, and the compiled files Python writes on the engine's
 * first start. Measured on one processor build (du, 2026-11-14): 107 MB of compiled files after its
 * first start, and 36 MB of cache beyond the tree where uv hard-links into the venv, 0.17 GB with
 * the archives. 1 GiB is six times that: room for the card build's larger tree, whose share was
 * not measured. Where uv cannot hard-link (it copies) the cache is a second tree, which this does
 * not cover.
 */
export const BUILD_MARGIN = 1024 ** 3;

/** The Linux build (linux-build.ts) of one engine version: what it downloads, and the build. */
export type BuildPlan = { kind: "build"; version: string; bytes: number; /** the built tree on disk, measured; absent, the guess below */ diskBytes?: number; run(onProgress: (p: InstallProgress) => void, signal: AbortSignal): Promise<void> };

/**
 * How this machine's engine is fetched: one pinned archive (Windows, and the e2e fake), or the Linux
 * build, whose `cpu` is the same engine without CUDA for a computer whose card cannot run pictures.
 */
export type EnginePlan =
  | { kind: "archive"; manifest: InstallManifest; layout: EngineLayout }
  | BuildPlan & { cpu?: BuildPlan };

/** The plan this computer runs: a build's processor one where pictures run on the processor. */
export const planFor = (plan: EnginePlan, cpu: boolean): EnginePlan => cpu && plan.kind === "build" && plan.cpu !== undefined ? plan.cpu : plan;

export interface ImageSetupDeps {
  appDataDir: string;
  /**
   * holdCard, heldCard, tryCard, onHeld: the card's build made beside the processor's is held until
   * it has started once (own.ts), so pictures keep running on the build that works.
   */
  own: Pick<OwnComfy, "installed" | "build" | "holdCard" | "heldCard" | "tryCard" | "onHeld">;
  /**
   * stopIdle: before a setup that built the card's engine starts it, the processor's ends if it is
   * idle. setupLeft: the model's files not already whole where its download goes.
   */
  image: Pick<ImageModule, "status" | "engine" | "start" | "download"> & Partial<Pick<ImageModule, "stopIdle" | "setupLeft">>;
  /** Records the device the engine runs on (own.ts reads it at start): "cpu" when the card cannot. */
  setDevice(device: "gpu" | "cpu"): void;
  /** The engine this machine would fetch (engineFor, or the e2e knob's); "later" where this release does not offer one on a system the app sets images up on; undefined where there is none. */
  engine(gpuName: string | undefined): EnginePlan | "later" | undefined;
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
  /** Starts the setup, or joins the one in progress. */
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
/** The disk the engine takes: a build's measured tree and its margin, else the download times the unpacking guess. */
const planDisk = (plan: EnginePlan) => plan.kind === "build" && plan.diskBytes !== undefined ? plan.diskBytes + BUILD_MARGIN : planBytes(plan) * UNPACK_FACTOR;
const planVersion =(plan: EnginePlan) => plan.kind === "archive" ? plan.manifest.version : plan.version;

/** The setup's download: every file its workflow loads, at the sizes the app's records give. */
function modelBytes(presetId: string): number {
  const preset = PRESETS.find((p) => p.id === presetId)!;
  return presetFiles(preset).reduce((sum, file) => sum + (preset.sources?.[file]?.bytes ?? 0), 0);
}

/** nvidia-smi names a card pictures run on (MIN_ROOM or more, to the nearest GB as imageRoom reads it). */
const runsPictures = (gpu: GpuStatus | undefined) => gpu?.vendor === "nvidia" && gpu.totalBytes !== undefined && cardBytes(gpu.totalBytes) >= MIN_ROOM;

export function createImageSetup(deps: ImageSetupDeps): ImageSetupModule {
  const log = deps.log ?? (() => {});
  let last: ImageSetupProgress | undefined;
  /** The run in progress builds the card's engine beside the processor's: each of its steps says so. */
  let toCardRun = false;
  /**
   * What was built against what the computer has now, at the app's start and each time the setup is
   * read: the device follows the card, so a card build whose card is gone runs on the processor
   * (started without --cpu it would not start at all), and on the card again once one is back. With
   * both builds whole it picks which one starts (own.ts). A card too small, or one nvidia-smi
   * cannot read, changes nothing.
   */
  const follow = (gpu: GpuStatus | undefined) => {
    if (!deps.own.installed()) return;
    if (gpu?.vendor === "none") deps.setDevice("cpu");
    else if (runsPictures(gpu)) deps.setDevice("gpu");
  };
  /** The setup in progress, from the click until its build and model end (or its checks refuse). */
  let running: Promise<{ started: true }> | undefined;
  /** The model step, while it runs: its setup, the bytes before it, and the whole run's. */
  let model: { preset: string; before: number; bytes: number; total: number; end(ended: { ok: boolean; message?: string }): void } | undefined;
  const say = (p: ImageSetupProgress) => {
    const said: ImageSetupProgress = toCardRun ? { ...p, toCard: true } : p;
    last = said;
    deps.push("image.setup", said);
  };

  const read = async (): Promise<{ info: ImageSetup; plan?: EnginePlan; cpu?: boolean; toCard?: boolean }> => {
    // The card's name, for the build the engine needs (engineFor: older cards take cu126), and
    // whether it runs pictures, against the build on disk.
    const gpu = await deps.gpuStatus().catch(() => undefined);
    try { follow(gpu); } catch (error) { log(`device not recorded: ${error instanceof Error ? error.message : String(error)}`); }
    const found = deps.engine(gpu?.name);
    const progress = last === undefined ? {} : { progress: last };
    const set = deps.settingsAddress();
    if (set !== undefined) return { info: { why: addressSet(set), ...progress } };
    if (found === "later") return { info: { why: NOT_YET, ...progress } };
    if (found === undefined) return { info: { why: NO_ENGINE, ...progress } };
    // Whether pictures run here, and on what, is the image module's held value; it is not worked out again here.
    await deps.image.status().catch(() => undefined);
    const { room } = deps.image.engine();
    if (room === undefined) return { info: { why: GPU_UNREAD, ...progress } };
    if (room > 0 && room < MIN_ROOM) return { info: { why: smallCard(room), ...progress } };
    // The image module says the processor (room 0) for the processor build whatever card is there,
    // so nvidia-smi says whether one is: with one, the card's build goes beside it (Linux, whose
    // build has both), and pictures run on the processor's until it is done.
    const built = deps.own.build?.();
    const toCard = built !== undefined && isProcessorBuild(built.version) && runsPictures(gpu) && found.kind === "build" && found.cpu !== undefined;
    const cpu = room === 0 && !toCard;
    // no card that runs pictures: the processor build, with no CUDA libraries to fetch
    const plan = planFor(found, cpu);
    const preset = PRESETS.find((p) => p.id === SETUP_PRESET)!;
    // The card's build beside the processor's counts as installed once it is whole on disk, held
    // until it is tried (a run whose model or start failed): nothing of it is left to fetch.
    const installed = toCard ? deps.own.heldCard?.() === planVersion(plan) : deps.own.installed();
    const engineBytes = planBytes(plan);
    // what the download fetches: a file already whole where it goes is skipped there, so it is not
    // said here, put on the drive or counted to; unknown, the whole model as the records give it
    const bytes = await deps.image.setupLeft?.(preset.id).catch(() => undefined) ?? modelBytes(preset.id);
    const freeBytes = await (deps.freeBytes ?? diskFree)(deps.appDataDir).catch(() => undefined);
    return {
      plan, cpu, toCard,
      info: {
        // installed, the build that is there (a card build the device runs on the processor stays the card's)
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

  // A card build that was not there after its start, at a picture: the row that offers the card
  // says so (a setup in progress says it at its own end).
  deps.own.onHeld?.(() => {
    if (running === undefined) say({ step: "error", completedBytes: 0, totalBytes: 0, message: CARD_NOT_STARTED, toCard: true });
  });

  // at the app's start, before a picture starts the engine
  void deps.gpuStatus().then(follow).catch((error: unknown) => log(`device not checked: ${error instanceof Error ? error.message : String(error)}`));

  return {
    info: async () => (await read()).info,
    // One setup at a time, from the click: a second click (another window) joins the run in progress
    // and gets its answer, and its progress comes on the same push.
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
      // the run says what follows the download's end: the engine's start, or the error
      if (p.ended === true) {
        if (p.state !== "done") say({ step: "model", completedBytes, totalBytes: total });
        model.end({ ok: p.state === "done", ...p.message === undefined ? {} : { message: p.message } });
        model = undefined;
      } else say({ step: "model", completedBytes, totalBytes: total });
    },
  };

  /** The run behind run(): its checks, then the build and the model in the background; `running` holds it until that ends. */
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
      // the processor's build is installed: the card's is built beside it, under its own name, and
      // held from before its tree is whole, so no start takes it until this run tries it
      if (toCard === true) deps.own.holdCard?.(planVersion(plan));
      if (toCard === true ? !info.engine!.installed : !deps.own.installed()) {
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
      // The processor's engine, idle, ends first, so this start is the card build's; one making a
      // picture keeps going, and its idle stop ends it (the next start is the card build's).
      if (toCard === true) {
        await deps.image.stopIdle?.().catch((error: unknown) => log(`the processor engine was not stopped: ${error instanceof Error ? error.message : String(error)}`));
        deps.own.tryCard?.();
      }
      await deps.image.start();
      // the card's engine was not there after its start: the processor's started in its place
      // (module.ts ensure), and is the build that runs until the card's is tried again
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
