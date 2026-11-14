// Builds the settings store, the runtime switch, the model list, the GPU
// watcher, downloads and the loader, wired to each other, for main.ts. All
// real-machine reads (nvidia-smi, /proc, systemctl --user show, Ollama's
// HTTP API) are read-only; nothing here stops or signals a process the app
// did not start.
import type { RuntimeMode } from "@gates-local/contracts";
import type { Push } from "../app.ts";
import { offerAfterRefusal } from "../fit/alternatives.ts";
import { fitEach, planLoad, type FitDeps } from "../fit/fit.ts";
import { catalogModels } from "./catalog.ts";
import type { FitReport } from "../fit/types.ts";
import { cached, procListeningPids, readGpuStatus, systemdMainPid } from "../fit/gpu-status.ts";
import { createGpuWatcher, type GpuWatcher } from "../fit/gpu-watch.ts";
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

/** models.refresh makes at most one real /api/tags call per this interval. */

/** The pick without a GPU reading: every model has no verdict. */
const noFit = async (_model: string): Promise<FitReport | undefined> => undefined;
export const MODELS_REFRESH_MIN_MS = 2000;
/** whisper-server's MainPID changes only on a restart; re-read it this often. */
const WHISPER_PID_TTL_MS = 60_000;
/** How long a switch waits for the old runtime's turns to end before it fails and keeps that runtime. */
const TURN_DRAIN_MS = 10_000;

export interface ModelServices {
  readonly settings: SettingsStore;
  readonly runtime: RuntimeSwitch;
  readonly catalog: ModelCatalog;
  readonly gpu: GpuWatcher;
  readonly pulls: PullManager;
  readonly loader: ModelLoader;
  /** The one owner of memory: the image module hands off through it too. */
  readonly memory: MemoryOwner;
  /** The image engine the handoff asks to free (bound once the image module exists). */
  bindEngine(engine: MemoryEngine): void;
  readonly handlers: Partial<Handlers>;
  /** Abort downloads, stop polling, stop the app's own Ollama if this process started it. */
  close(options: { stopRuntime: boolean }): Promise<void>;
  /** Shutdown ran out of time: see OllamaRuntime.killNow. */
  killRuntimeNow(): void;
}

export interface ModelServicesOptions {
  readonly admit?: () => void;
  readonly dataDir: string;
  /** Bound late: the ws server exists after the handlers. */
  readonly push: Push;
  /** Extra runtime options (external URL, allowInstall). */
  readonly runtime?: Omit<RuntimeOptions, "mode">;
  readonly log?: (line: string) => void;
  /** The nvidia-smi runner and meminfo reader for the GPU status and every fit check (tests inject fakes), and the card's baseline for the catalog's download estimates. */
  readonly fit?: Pick<FitDeps, "runNvidiaSmi" | "readMeminfo" | "baseline">;
  /** The app's one GPU lease: models.load takes a shared chat claim on it. */
  readonly lease?: GpuLease;
  /**
   * The registry asked for the size of a model the curated list does not hold, before Ollama has
   * named all its files. Unset: never asked (tests, a pinned Ollama), and such a download shows no
   * total until it is done.
   */
  readonly modelRegistry?: string;
  /** How long a switch waits for the old runtime's turns to end before it fails (default 10 s). */
  readonly turnDrainMs?: number;
  /** The ComfyUI process the app runs, from the image module's held engine value (bound late). */
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

  // Late-bound so the switch can abort downloads made against the old runtime
  // and tell the loader the runtime changed. The loader also feeds the GPU
  // status's ownership, and the watcher refreshes after loads.
  let pulls: PullManager | undefined;
  let loader: ModelLoader | undefined;
  /** The image engine, bound by main once the image module exists. */
  let engine: MemoryEngine | undefined;
  const runtime = createRuntimeSwitch({
    initialMode: settings.get().runtimeMode,
    // Everything follows --data-dir: the ownership record, the serve log, the
    // install and the models folder, so two instances never share a mutable
    // model store. An explicit runtime.appDataDir still wins.
    make: (mode: RuntimeMode) => createOllamaRuntime({ appDataDir: options.dataDir, ...options.runtime, mode, stateDir: options.dataDir }),
    beforeSwitch: async () => {
      pulls?.stop();
      // Before the old runtime stops: what the app owned in it is not its own any more, and
      // loads and turns are refused until the new runtime's ensure settles (afterSwitch).
      loader?.runtimeChanged();
      // Every turn reserved against the old runtime was told to end, and a turn ends at once
      // (app.ts drops whatever it waits on); wait for them, so none sends another request to a
      // runtime being stopped. Bounded: a turn still running after the bound fails the switch,
      // which keeps the old runtime (never stops it under a running turn).
      if (loader === undefined) return;
      const drained = loader.turnsEnded();
      const drainMs = options.turnDrainMs ?? TURN_DRAIN_MS;
      const ended = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), drainMs);
        void drained.then(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!ended) throw new Error(`turns on the old runtime still running after ${drainMs} ms`);
    },
    afterSwitch: () => loader?.runtimeSettled(),
    log,
  });
  const catalog = createModelCatalog(() => runtime.baseUrl(), {
    minIntervalMs: MODELS_REFRESH_MIN_MS,
    // The chat pick (runtime/pick.ts): one GPU reading, every chat model fitted against it.
    pick: async (models, baseUrl) => {
      // Nothing to pick from (an Ollama too old to say, only embedding models): skip the GPU and memory reads each retry would take.
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
  /** The models the GPU status last read in the app's Ollama: all but a running reply's leave for the next thing. */
  let resident: readonly string[] = [];
  const gpu = createGpuWatcher({
    read: () =>
      readGpuStatus({
        ...options.fit,
        whisperPid,
        listeningPids: procListeningPids,
        ...options.imagePid ? { imagePid: options.imagePid } : {},
        modelLabel,
        // Unprotected is what the next thing in memory asks to leave (gpu/memory.ts): every resident
        // model no running reply uses, whoever loaded it. From the same /api/ps, no second read.
        mayUnload: () => {
          const replying = new Set(loader?.replying() ?? []);
          return resident.filter((tag) => !replying.has(tag));
        },
        // The loader reads /api/ps for the runtime it owns now and prunes against it.
        residentModels: async () => {
          const models = ((await loader?.residentModels()) ?? []).map((m) => ({ name: canonicalTag(m.name), sizeVramBytes: m.sizeVramBytes }));
          resident = models.map((m) => m.name);
          return models;
        },
      }),
    push: (status) => options.push("gpu.changed", status),
    log,
  });

  // The one owner of memory (gpu/memory.ts): every load, send and image job hands off through it.
  const owner = createMemoryOwner({
    ollamaUrl: () => runtime.baseUrl(),
    listLoaded: (url, signal) => listLoaded(url, undefined, signal),
    replying: () => loader?.replying() ?? [],
    engine: () => engine,
    readFree: async (signal) => (await readGpu(options.fit?.runNvidiaSmi ?? defaultNvidiaSmi, Date.now, signal)).freeBytes,
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
    // The runtime the load captured, never whatever baseUrl() says by the time the fit runs.
    // `signal` (shutdown, a switch) ends every request and child process of the check.
    // The planner chat.send uses (fit/planLoad), after the handoff: the reading alone decides.
    // A preload stops nothing: models a turn or another preload holds are busy.
    fit: async (model, numCtx, baseUrl, signal) =>
      (await planLoad({ ...options.fit, baseUrl, model, numCtx, signal, busy: loader?.busyModels() ?? [], measured: true })).report,
    memory: owner,
    // A refusal's offer: what runs instead, planned the same way on the reading that refused.
    offer: (refused, baseUrl) => offerAfterRefusal({
      ...options.fit,
      baseUrl,
      models: catalogModels(catalog.current() ?? []).filter((m) => m.installed).map((m) => m.name),
      defaultNumCtx: settings.get().defaultNumCtx,
      busy: loader?.busyModels() ?? [],
    }, refused),
    // a load changed the GPU: no fit after it reuses a reading from before it
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

  // Each mode choice gets a generation; only the newest one's failure puts Settings back.
  let requested = 0;
  let puttingBack = false;
  settings.onChange((next, previous) => {
    // The pick depends on the default model and context; models.changed carries the new one.
    if (next.defaultModel !== previous.defaultModel || next.defaultNumCtx !== previous.defaultNumCtx) {
      catalog.refresh({ force: true }).catch((e: unknown) => log(`model refresh failed: ${(e as Error).message}`));
    }
    if (puttingBack || next.runtimeMode === previous.runtimeMode) return;
    const generation = ++requested;
    runtime.setMode(next.runtimeMode).then(
      (s) => log(`runtime mode ${next.runtimeMode}: ${s.state} (${s.owner}) at ${s.baseUrl}`),
      (e: unknown) => {
        log(`runtime switch failed: ${(e as Error).message}`);
        // A newer choice is queued behind this one and decides the mode.
        if (generation !== requested) return;
        // The old runtime still serves: Settings says so, and choosing the new mode again retries.
        // Putting it back schedules no switch.
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
    // What is in memory now, and the handoff under way (gpu/memory.ts); memory.changed pushes each change.
    "memory.status": () => owner.status(),
    ...createSettingsHandlers({ settings, push: options.push, baseUrl: () => runtime.baseUrl() }),
    ...createGpuHandlers({ gpu }),
    // The catalog's fit survey reads the same injected GPU and memory as every other fit.
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
      pulls?.stop();
      gpu.stop();
      catalog.stop();
      if (stopRuntime) await runtime.stopIfStartedHere();
    },
  };
}
