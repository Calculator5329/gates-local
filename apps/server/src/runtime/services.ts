import type { RuntimeMode } from "@gates-local/contracts";
import type { Push } from "../app/push.ts";
import { offerAfterRefusal } from "../fit/alternatives.ts";
import { fitEach, planLoad, type FitDeps } from "../fit/fit.ts";
import { catalogModels } from "./catalog.ts";
import type { FitReport } from "../fit/types.ts";
import { cached, procListeningPids, readGpuStatus, systemdMainPid } from "../fit/gpu-status.ts";
import { createGpuWatcher, type GpuWatcher } from "../fit/gpu-watch.ts";
import { answerHoldsOne } from "../fit/one-model.ts";
import { defaultNvidiaSmi, forgetGpuReadings, readGpu } from "../fit/gpu.ts";
import { createMemoryOwner, type MemoryEngine, type MemoryOwner } from "../gpu/memory.ts";
import { createGpuHandlers } from "../fit/handlers.ts";
import { createSettingsHandlers } from "../settings/handlers.ts";
import { openSettingsStore, type SettingsStore } from "../settings/store.ts";
import type { GpuLease } from "../gpu/lease.ts";
import type { Handlers } from "../ws/server.ts";
import { createRuntimeHandlers } from "./handlers.ts";
import { createModelLoader, type ModelLoader } from "./load.ts";
import { createModelCatalog, listLoaded, type ModelCatalog } from "./models.ts";
import { canChat, pickChatModel } from "./pick.ts";
import { probe } from "./probe.ts";
import { createPullManager, type PullManager } from "./pull.ts";
import { canonicalTag, curated, modelLabel } from "./recommended.ts";
import { registryLookup, registrySize } from "./registry-size.ts";
import { createOllamaRuntime, DEFAULT_EXTERNAL_BASE_URL, type RuntimeOptions } from "./runtime.ts";
import { createRuntimeSwitch, type RuntimeSwitch } from "./switch.ts";

const noFit = async (_model: string): Promise<FitReport | undefined> => undefined;
export const MODELS_REFRESH_MIN_MS = 2000;
// why: whisper-server's MainPID changes only on a restart
const WHISPER_PID_TTL_MS = 60_000;
export const TURN_DRAIN_MS = 10_000;

export async function endTurnsForSwitch(loader: Pick<ModelLoader, "runtimeChanged" | "turnsEnded" | "runtimeKept"> | undefined, drainMs: number): Promise<void> {
  if (loader === undefined) return;
  loader.runtimeChanged();
  const drained = loader.turnsEnded();
  const ended = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), drainMs);
    void drained.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (ended) return;
  loader.runtimeKept();
  throw new Error(`turns on the old runtime still running after ${drainMs} ms`);
}

export interface ModelServices {
  readonly settings: SettingsStore;
  readonly runtime: RuntimeSwitch;
  readonly catalog: ModelCatalog;
  readonly gpu: GpuWatcher;
  readonly pulls: PullManager;
  readonly loader: ModelLoader;
  readonly memory: MemoryOwner;
  bindEngine(engine: MemoryEngine): void;
  readonly handlers: Partial<Handlers>;
  close(options: { stopRuntime: boolean }): Promise<void>;
  killRuntimeNow(): void;
}

export interface ModelServicesOptions {
  readonly admit?: () => void;
  readonly dataDir: string;
  readonly push: Push;
  readonly runtime?: Omit<RuntimeOptions, "mode">;
  readonly log?: (line: string) => void;
  readonly fit?: Pick<FitDeps, "runNvidiaSmi" | "readMeminfo" | "baseline">;
  readonly lease?: GpuLease;
  readonly modelRegistry?: string;
  readonly turnDrainMs?: number;
  readonly imagePid?: () => number | undefined;
}

export async function createModelServices(options: ModelServicesOptions): Promise<ModelServices> {
  const log = options.log ?? (() => undefined);
  const externalBaseUrl = options.runtime?.externalBaseUrl ?? DEFAULT_EXTERNAL_BASE_URL;
  const settings = await openSettingsStore({
    dataDir: options.dataDir,
    systemOllamaAnswers: async () => (await probe(externalBaseUrl)).kind === "ollama",
  });
  if (settings.loadNote) log(settings.loadNote);

  // why: late-bound, since the switch is made before the downloads and the loader it calls
  let pulls: PullManager | undefined;
  let loader: ModelLoader | undefined;
  let engine: MemoryEngine | undefined;
  const runtime = createRuntimeSwitch({
    initialMode: settings.get().runtimeMode,
    make: (mode: RuntimeMode) => createOllamaRuntime({ appDataDir: options.dataDir, ...options.runtime, mode, stateDir: options.dataDir }),
    beforeSwitch: async () => {
      pulls?.stop();
      await endTurnsForSwitch(loader, options.turnDrainMs ?? TURN_DRAIN_MS);
    },
    afterSwitch: () => loader?.runtimeSettled(),
    log,
  });
  const catalog = createModelCatalog(() => runtime.baseUrl(), {
    minIntervalMs: MODELS_REFRESH_MIN_MS,
    pick: async (models, baseUrl) => {
      if (!models.some(canChat)) return undefined;
      const { defaultModel, defaultNumCtx } = settings.get();
      let fit: (model: string) => Promise<FitReport | undefined> = noFit;
      try {
        fit = await fitEach({ ...options.fit, baseUrl, numCtx: defaultNumCtx });
      } catch (e) {
        log(`chat pick has no fit reading: ${(e as Error).message}`);
      }
      return pickChatModel({ models, numCtx: defaultNumCtx, fit, ...(defaultModel === undefined ? {} : { defaultModel }) });
    },
    pickKey: () => `${settings.get().defaultModel ?? ""}|${settings.get().defaultNumCtx}`,
    log,
  });

  const whisperPid = cached(() => systemdMainPid("whisper-server.service"), WHISPER_PID_TTL_MS);
  const gpu = createGpuWatcher({
    read: () =>
      readGpuStatus({
        ...options.fit,
        whisperPid,
        listeningPids: procListeningPids,
        ...options.imagePid ? { imagePid: options.imagePid } : {},
        modelLabel,
        mayUnload: () => {
          const replying = new Set(loader?.replying() ?? []);
          return owner.loaded.listed().filter((tag) => !replying.has(tag));
        },
        residentModels: async () => ((await loader?.residentModels()) ?? []).map((m) => ({ name: canonicalTag(m.name), sizeVramBytes: m.sizeVramBytes })),
      }),
    push: (status) => options.push("gpu.changed", status),
    log,
  });

  const holdsOne = () => runtime.baseUrl() !== undefined && runtime.status().holdsOne === true;
  const forgetHoldsOne = answerHoldsOne((baseUrl) => holdsOne() && runtime.baseUrl() === baseUrl);
  const owner = createMemoryOwner({
    ollamaUrl: () => runtime.baseUrl(),
    holdsOne,
    listLoaded: (url, signal) => listLoaded(url, undefined, signal),
    replying: () => loader?.replying() ?? [],
    engine: () => engine,
    readFree: async (signal) => {
      const reading = await readGpu(options.fit?.runNvidiaSmi ?? defaultNvidiaSmi, Date.now, signal);
      return reading.gpuCount === 0 ? undefined : reading.freeBytes;
    },
    onUnloaded: (model) => {
      loader?.unloaded(model);
      forgetGpuReadings();
      gpu.poke();
    },
    onChanged: (state) => options.push("memory.changed", state),
    log,
  });
  loader = createModelLoader({
    baseUrl: () => runtime.baseUrl(),
    push: (load) => options.push("models.load", load),
    listLoaded: (url, signal) => listLoaded(url, undefined, signal),
    fit: async (model, numCtx, baseUrl, signal) =>
      (await planLoad({ ...options.fit, baseUrl, model, numCtx, signal, busy: loader?.busyModels() ?? [], measured: true })).report,
    memory: owner,
    offer: (refused, baseUrl) => offerAfterRefusal({
      ...options.fit,
      baseUrl,
      models: catalogModels(catalog.current() ?? []).filter((m) => m.installed).map((m) => m.name),
      defaultNumCtx: settings.get().defaultNumCtx,
      busy: loader?.busyModels() ?? [],
    }, refused),
    // why: a fit after a load must not reuse a GPU reading from before it
    onLoaded: () => { forgetGpuReadings(); gpu.poke(); },
    ...(options.lease ? { lease: options.lease } : {}),
    log,
  });
  pulls = createPullManager({
    ...(options.admit ? { admit: options.admit } : {}),
    baseUrl: () => runtime.baseUrl(),
    push: (p) => options.push("models.pull", p),
    sizeOf: (name, signal) => {
      const known = curated(name)?.downloadBytes;
      if (known !== undefined || options.modelRegistry === undefined) return known;
      return registrySize(name, signal, { registry: options.modelRegistry });
    },
    onDone: async () => {
      await catalog.refresh({ force: true });
    },
    log,
  });

  let requested = 0;
  let puttingBack = false;
  settings.onChange((next, previous) => {
    if (next.defaultModel !== previous.defaultModel || next.defaultNumCtx !== previous.defaultNumCtx) {
      catalog.refresh({ force: true }).catch((e: unknown) => log(`model refresh failed: ${(e as Error).message}`));
    }
    if (puttingBack || next.runtimeMode === previous.runtimeMode) return;
    const generation = ++requested;
    runtime.setMode(next.runtimeMode).then(
      (s) => log(`runtime mode ${next.runtimeMode}: ${s.state} (${s.owner}) at ${s.baseUrl}`),
      (e: unknown) => {
        log(`runtime switch failed: ${(e as Error).message}`);
        if (generation !== requested) return;
        puttingBack = true;
        try {
          const restored = settings.update({ runtimeMode: runtime.mode() });
          options.push("settings.changed", restored, [settings.stamp(restored)]);
        } catch (error) {
          log(`settings not put back to ${runtime.mode()}: ${(error as Error).message}`);
        } finally {
          puttingBack = false;
        }
      },
    );
  });

  const handlers = {
    "memory.status": () => owner.status(),
    ...createSettingsHandlers({ settings, push: options.push, baseUrl: () => runtime.baseUrl() }),
    ...createGpuHandlers({ gpu }),
    ...createRuntimeHandlers({
      baseUrl: () => runtime.baseUrl(),
      catalog,
      settings,
      pulls,
      loader,
      log,
      ...(options.fit ? { fit: options.fit } : {}),
      ...(options.modelRegistry === undefined ? {} : { lookup: (name: string, signal: AbortSignal) => registryLookup(name, signal, { registry: options.modelRegistry }) }),
    }),
  } satisfies Partial<Handlers>;

  return {
    settings,
    runtime,
    catalog,
    gpu,
    pulls,
    loader,
    memory: owner,
    bindEngine: (next) => { engine = next; },
    handlers,
    killRuntimeNow: () => runtime.killNow(),
    async close({ stopRuntime }) {
      forgetHoldsOne();
      pulls?.stop();
      gpu.stop();
      catalog.stop();
      if (stopRuntime) await runtime.stopIfStartedHere();
    },
  };
}
