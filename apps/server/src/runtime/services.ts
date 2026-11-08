// Builds the settings store, the runtime switch, the model list, the GPU
// watcher, downloads and the loader, wired to each other, for main.ts. All
// real-machine reads (nvidia-smi, /proc, systemctl --user show, Ollama's
// HTTP API) are read-only; nothing here stops or signals a process the app
// did not start.
import type { Channel, Payload, RuntimeMode } from "@gates-local/contracts";
import { checkFit, type FitDeps } from "../fit/fit.ts";
import { cached, procListeningPids, readGpuStatus, systemdMainPid } from "../fit/gpu-status.ts";
import { createGpuWatcher, type GpuWatcher } from "../fit/gpu-watch.ts";
import { createGpuHandlers } from "../fit/handlers.ts";
import { createSettingsHandlers } from "../settings/handlers.ts";
import { openSettingsStore, type SettingsStore } from "../settings/store.ts";
import type { GpuLease } from "../gpu/lease.ts";
import type { Handlers } from "../ws/server.ts";
import { createRuntimeHandlers } from "./handlers.ts";
import { createModelLoader, type ModelLoader } from "./load.ts";
import { createModelCatalog, listLoaded, type ModelCatalog } from "./models.ts";
import { probe } from "./probe.ts";
import { createPullManager, type PullManager } from "./pull.ts";
import { canonicalTag, modelLabel } from "./recommended.ts";
import { createOllamaRuntime, DEFAULT_EXTERNAL_BASE_URL, type RuntimeOptions } from "./runtime.ts";
import { createRuntimeSwitch, type RuntimeSwitch } from "./switch.ts";

/** models.refresh makes at most one real /api/tags call per this interval. */
export const MODELS_REFRESH_MIN_MS = 2000;
/** whisper-server's MainPID changes only on a restart; re-read it this often. */
const WHISPER_PID_TTL_MS = 60_000;
/** How long a switch waits for the old runtime's turns to end before it fails and keeps that runtime. */
const TURN_DRAIN_MS = 10_000;

type Push = <C extends Channel>(channel: C, payload: Payload<C>) => void;

export interface ModelServices {
  readonly settings: SettingsStore;
  readonly runtime: RuntimeSwitch;
  readonly catalog: ModelCatalog;
  readonly gpu: GpuWatcher;
  readonly pulls: PullManager;
  readonly loader: ModelLoader;
  readonly handlers: Partial<Handlers>;
  /** Abort downloads, stop polling, stop the app's own Ollama if this process started it. */
  close(options: { stopRuntime: boolean }): Promise<void>;
}

export interface ModelServicesOptions {
  readonly dataDir: string;
  /** Bound late: the ws server exists after the handlers. */
  readonly push: Push;
  /** Extra runtime options (external URL, allowInstall). */
  readonly runtime?: Omit<RuntimeOptions, "mode">;
  readonly log?: (line: string) => void;
  /** The nvidia-smi runner and meminfo reader for the GPU status and every fit check (tests inject fakes). */
  readonly fit?: Pick<FitDeps, "runNvidiaSmi" | "readMeminfo">;
  /** The app's one GPU lease: models.load takes a shared chat claim on it. */
  readonly lease?: GpuLease;
  /** How long a switch waits for the old runtime's turns to end before it fails (default 10 s). */
  readonly turnDrainMs?: number;
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
  const catalog = createModelCatalog(() => runtime.baseUrl(), { minIntervalMs: MODELS_REFRESH_MIN_MS });

  const whisperPid = cached(() => systemdMainPid("whisper-server.service"), WHISPER_PID_TTL_MS);
  const gpu = createGpuWatcher({
    read: () =>
      readGpuStatus({
        ...options.fit,
        whisperPid,
        listeningPids: procListeningPids,
        modelLabel,
        appLoaded: () => loader?.appLoadedModels() ?? [],
        residentModels: async () => {
          const baseUrl = runtime.baseUrl();
          if (baseUrl === undefined) return [];
          const ps = await listLoaded(baseUrl);
          loader?.prune(ps.map((m) => m.name));
          return ps.map((m) => ({ name: canonicalTag(m.name), sizeVramBytes: m.sizeVramBytes }));
        },
      }),
    push: (status) => options.push("gpu.changed", status),
    log,
  });

  loader = createModelLoader({
    baseUrl: () => runtime.baseUrl(),
    push: (load) => options.push("models.load", load),
    listLoaded: (url, signal) => listLoaded(url, undefined, signal),
    // The runtime the load captured, never whatever baseUrl() says by the time the fit runs.
    // `signal` (shutdown, a switch) ends every request and child process of the check.
    fit: async (model, numCtx, baseUrl, signal) => (await checkFit({ ...options.fit, baseUrl, model, numCtx, signal })).report,
    onLoaded: () => gpu.poke(),
    ...(options.lease ? { lease: options.lease } : {}),
    log,
  });
  pulls = createPullManager({
    baseUrl: () => runtime.baseUrl(),
    push: (p) => options.push("models.pull", p),
    onDone: async () => {
      await catalog.refresh({ force: true });
    },
    log,
  });

  settings.onChange((next, previous) => {
    if (next.runtimeMode === previous.runtimeMode) return;
    runtime.setMode(next.runtimeMode).then(
      (s) => log(`runtime mode ${next.runtimeMode}: ${s.state} (${s.owner}) at ${s.baseUrl}`),
      (e: unknown) => {
        log(`runtime switch failed: ${(e as Error).message}`);
        // The old runtime still serves: Settings says so, and choosing the new mode again retries.
        if (settings.get().runtimeMode !== next.runtimeMode) return;
        try {
          options.push("settings.changed", settings.update({ runtimeMode: runtime.mode() }));
        } catch (error) {
          log(`settings not put back to ${runtime.mode()}: ${(error as Error).message}`);
        }
      },
    );
  });

  const handlers = {
    ...createSettingsHandlers({ settings, push: options.push }),
    ...createGpuHandlers({ gpu }),
    // The catalog's fit survey reads the same injected GPU and memory as every other fit.
    ...createRuntimeHandlers({ baseUrl: () => runtime.baseUrl(), catalog, settings, pulls, loader, log, ...(options.fit ? { fit: options.fit } : {}) }),
  } satisfies Partial<Handlers>;

  return {
    settings,
    runtime,
    catalog,
    gpu,
    pulls,
    loader,
    handlers,
    async close({ stopRuntime }) {
      pulls?.stop();
      gpu.stop();
      if (stopRuntime) await runtime.stopIfStartedHere();
    },
  };
}
