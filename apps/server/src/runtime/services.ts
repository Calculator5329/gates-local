// Builds the settings store, the runtime switch, the model list, the GPU
// watcher, downloads and the loader, wired to each other, for main.ts. All
// real-machine reads (nvidia-smi, /proc, systemctl --user show, Ollama's
// HTTP API) are read-only; nothing here stops or signals a process the app
// did not start.
import type { Channel, Payload, RuntimeMode } from "@gates-local/contracts";
import { checkFit, fitEach, type FitDeps } from "../fit/fit.ts";
import type { FitReport } from "../fit/types.ts";
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
import { pickChatModel } from "./pick.ts";
import { probe } from "./probe.ts";
import { createPullManager, type PullManager } from "./pull.ts";
import { canonicalTag, modelLabel } from "./recommended.ts";
import { createOllamaRuntime, DEFAULT_EXTERNAL_BASE_URL, type RuntimeOptions } from "./runtime.ts";
import { createRuntimeSwitch, type RuntimeSwitch } from "./switch.ts";

/** models.refresh makes at most one real /api/tags call per this interval. */

/** The pick without a GPU reading: every model has no verdict. */
const noFit = async (_model: string): Promise<FitReport | undefined> => undefined;
export const MODELS_REFRESH_MIN_MS = 2000;
/** whisper-server's MainPID changes only on a restart; re-read it this often. */
const WHISPER_PID_TTL_MS = 60_000;

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
    // The ownership record and serve log follow --data-dir; the install and the models folder stay shared.
    make: (mode: RuntimeMode) => createOllamaRuntime({ ...options.runtime, mode, stateDir: options.dataDir }),
    beforeSwitch: () => {
      pulls?.stop();
      // Before the new runtime's ensure: what the app owned in the old one is not its own any more.
      loader?.runtimeChanged();
    },
    log,
  });
  const catalog = createModelCatalog(() => runtime.baseUrl(), {
    minIntervalMs: MODELS_REFRESH_MIN_MS,
    // The chat pick (runtime/pick.ts): one GPU reading, every chat model fitted against it.
    pick: async (models, baseUrl) => {
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
    listLoaded: (url) => listLoaded(url),
    fit: async (model, numCtx) => {
      const baseUrl = runtime.baseUrl();
      if (baseUrl === undefined) throw new Error("Ollama is not running.");
      return (await checkFit({ ...options.fit, baseUrl, model, numCtx })).report;
    },
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
    // The pick depends on the default model and context; models.changed carries the new one.
    if (next.defaultModel !== previous.defaultModel || next.defaultNumCtx !== previous.defaultNumCtx) {
      catalog.refresh({ force: true }).catch((e: unknown) => log(`model refresh failed: ${(e as Error).message}`));
    }
    if (next.runtimeMode === previous.runtimeMode) return;
    runtime.setMode(next.runtimeMode).then(
      (s) => log(`runtime mode ${next.runtimeMode}: ${s.state} (${s.owner}) at ${s.baseUrl}`),
      (e: unknown) => log(`runtime switch failed: ${(e as Error).message}`),
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
