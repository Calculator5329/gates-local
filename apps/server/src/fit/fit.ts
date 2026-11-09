// The fit check: measured free VRAM (with whisper and every other tenant
// already counted by nvidia-smi) against a model's need at a num_ctx.
//
// fits    need <= free VRAM - VRAM margin
// spills  the overflow fits in MemAvailable - RAM margin; spillRamBytes shown
// refuse  otherwise, with shortfallBytes and a message naming the numbers
//
// A download size alone never proves a fit: the estimate adds KV cache and
// overhead, and a measured /api/ps report replaces it after a real load.
import {
  KV_REFERENCE_CONTEXT,
  PREDOWNLOAD_KV_FRACTION_PER_16K,
  RAM_SAFETY_MARGIN_BYTES,
  RUNTIME_OVERHEAD_BYTES,
  VRAM_SAFETY_MARGIN_BYTES,
} from "./constants.ts";
import { effectiveNumCtx, estimateNeed, parseArchInfo, reportedContextLength, type EstimateOptions } from "./estimate.ts";
import { formatBytes, formatGb } from "./format.ts";
import { defaultMeminfo, defaultNvidiaSmi, gpuReadingConflict, readGpu, readMemAvailable, untilAborted } from "./gpu.ts";
import { fetchPs, fetchShow, fetchTags, findLoaded, sameModel, type PsEntry, type PsResponse, type TagsResponse } from "./ollama.ts";
import {
  FitError,
  type FitReport,
  type GpuSnapshot,
  type MeminfoReader,
  type NeedEstimate,
  type NvidiaSmiRunner,
} from "./types.ts";

export interface Margins {
  vramMarginBytes: number;
  ramMarginBytes: number;
}

export const DEFAULT_MARGINS: Margins = {
  vramMarginBytes: VRAM_SAFETY_MARGIN_BYTES,
  ramMarginBytes: RAM_SAFETY_MARGIN_BYTES,
};

export interface DecideInput {
  model: string;
  numCtx: number;
  needBytes: number;
  freeVramBytes: number;
  memAvailableBytes: number;
  margins?: Margins;
  measuredAt: number;
  /** Prefix for the message, e.g. why free VRAM was adjusted. */
  note?: string;
}

/** Pure verdict from an estimated need and measured free memory. */
export function decideFit(input: DecideInput): FitReport {
  const margins = input.margins ?? DEFAULT_MARGINS;
  const usableVram = Math.max(0, input.freeVramBytes - margins.vramMarginBytes);
  const usableRam = Math.max(0, input.memAvailableBytes - margins.ramMarginBytes);
  const head =
    `${input.model} at num_ctx ${input.numCtx} needs ${formatGb(input.needBytes)} (estimate); ` +
    `VRAM usable ${formatGb(usableVram)} (${formatGb(input.freeVramBytes)} free minus ${formatGb(margins.vramMarginBytes)} margin)` +
    (input.note ? `; ${input.note}` : "");
  const base = {
    model: input.model,
    numCtx: input.numCtx,
    freeVramBytes: input.freeVramBytes,
    needVramBytes: input.needBytes,
    source: "estimate" as const,
    measuredAt: input.measuredAt,
  };
  if (input.needBytes <= usableVram) {
    return { ...base, verdict: "fits", spillRamBytes: 0, message: `${head}: fits.` };
  }
  const overflow = input.needBytes - usableVram;
  const ramNote = `RAM usable for spill ${formatGb(usableRam)} (${formatGb(input.memAvailableBytes)} available minus ${formatGb(margins.ramMarginBytes)} margin)`;
  if (overflow <= usableRam) {
    return {
      ...base,
      verdict: "spills",
      spillRamBytes: overflow,
      message: `${head}; ${ramNote}: spills ${formatBytes(overflow)} to system RAM.`,
    };
  }
  const shortfall = overflow - usableRam;
  return {
    ...base,
    verdict: "refuse",
    spillRamBytes: 0,
    shortfallBytes: shortfall,
    message: `${head}; ${ramNote}: refused, short by ${formatBytes(shortfall)}.`,
  };
}

/**
 * A measured report from an /api/ps entry plus the GPU reading taken after
 * the load. /api/ps leaves out the runner's CUDA context and scratch (on
 * this machine qwen3.5:9b showed size_vram 5.92 GB while nvidia-smi showed
 * the runner at 6926 MiB), so when exactly one model is loaded the runner
 * processes' nvidia-smi memory counts as its VRAM if larger.
 */
export function measuredReport(entry: PsEntry, numCtx: number, gpu: GpuSnapshot, loadedCount = 1): FitReport {
  const spill = Math.max(0, entry.size - entry.size_vram);
  const ctx = entry.context_length ?? numCtx;
  const runners = gpu.tenants.filter((t) => t.role === "ollama" && t.usedBytes !== undefined);
  const runnerBytes = loadedCount === 1 && runners.length > 0 ? runners.reduce((sum, t) => sum + (t.usedBytes ?? 0), 0) : undefined;
  const vram = Math.max(entry.size_vram, runnerBytes ?? 0);
  const runnerNote =
    runnerBytes === undefined
      ? "runner VRAM not attributable (nvidia-smi shows no single runner)"
      : `runner holds ${formatGb(runnerBytes)} on the GPU per nvidia-smi`;
  return {
    model: entry.name,
    numCtx: ctx,
    freeVramBytes: gpu.freeBytes,
    needVramBytes: vram + spill,
    spillRamBytes: spill,
    verdict: spill > 0 ? "spills" : "fits",
    source: "measured",
    measuredAt: gpu.measuredAt,
    message:
      `${entry.name} loaded at num_ctx ${ctx}: /api/ps ${formatGb(entry.size)} total, ${formatGb(entry.size_vram)} in VRAM; ${runnerNote}` +
      (spill > 0 ? `; ${formatBytes(spill)} spilled to system RAM` : "; nothing spilled") +
      `; ${formatGb(gpu.freeBytes)} VRAM free now (measured).`,
  };
}

export interface FitDeps {
  baseUrl: string;
  runNvidiaSmi?: NvidiaSmiRunner;
  readMeminfo?: MeminfoReader;
  now?: () => number;
  margins?: Margins;
  estimate?: EstimateOptions;
  /** Ends the check early: every Ollama request, both nvidia-smi runs and the meminfo read. */
  signal?: AbortSignal;
  /**
   * Resident models no turn of this app is using (or whose turn was just stopped for this load):
   * Ollama unloads a model it is not serving to make room, so the VRAM /api/ps says they hold
   * counts as reclaimable for a cold plan. Their activity is unknown: another client of the same
   * Ollama may be using one, and Ollama then queues the load until it is done.
   */
  reclaim?: readonly string[];
}

export interface FitCheck {
  report: FitReport;
  /** The GPU reading the verdict used, tenants named (whisper permanent). */
  gpu?: GpuSnapshot;
  memAvailableBytes?: number;
  estimate?: NeedEstimate;
}

interface Readings {
  gpu: GpuSnapshot;
  memAvailableBytes: number;
  ps: PsResponse;
  tags: TagsResponse;
}

async function takeReadings(deps: FitDeps): Promise<Readings> {
  const now = deps.now ?? Date.now;
  const { signal } = deps;
  const [gpu, memAvailableBytes, ps, tags] = await untilAborted(
    Promise.all([
      readGpu(deps.runNvidiaSmi ?? defaultNvidiaSmi, now, signal),
      readMemAvailable(deps.readMeminfo ?? defaultMeminfo, signal),
      fetchPs(deps.baseUrl, signal),
      fetchTags(deps.baseUrl, signal),
    ]),
    signal,
  );
  const conflict = gpuReadingConflict(gpu.unavailableDetail, ps.models.map(model => model.size_vram));
  if (conflict !== undefined) throw new FitError("gpu-unreadable", conflict);
  return { gpu, memAvailableBytes, ps, tags };
}

/** `comfyBytes`: the app-owned ComfyUI's GPU memory, counted as reclaimable when the plan stops it. */
async function fitWithReadings(deps: FitDeps, model: string, requested: number, r: Readings, comfyBytes = 0): Promise<FitCheck> {
  const loaded = findLoaded(r.ps, model);
  const measured = (numCtx: number): FitCheck => ({ report: measuredReport(loaded as PsEntry, numCtx, r.gpu, r.ps.models.length), gpu: r.gpu, memAvailableBytes: r.memAvailableBytes });
  // Measured only when /api/ps proves the resident copy runs at this num_ctx. An Ollama that
  // leaves context_length out may hold it at a smaller one, so that copy is estimated like a cold one.
  if (loaded && loaded.context_length === requested) return measured(requested);

  const tag = r.tags.models.find((m) => sameModel(m.name, model));
  if (!tag) throw new FitError("model-not-found", `${model} is not in /api/tags`);
  const show = await untilAborted(fetchShow(deps.baseUrl, model, deps.signal), deps.signal);
  // The one place the size a model runs at is decided; the report carries it to every caller.
  const numCtx = effectiveNumCtx(requested, reportedContextLength(show.model_info));
  if (numCtx !== requested && loaded?.context_length === numCtx) return measured(numCtx);
  const estimate = needAt(model, numCtx, tag.size, show.model_info, deps.estimate);

  // A copy loaded at another num_ctx is replaced by Ollama on the next
  // request, so the VRAM it holds counts as free for this plan. At an unknown
  // context it is either replaced or reused as is; either way the question is
  // whether the model at this num_ctx fits in what it holds plus what is free.
  const reclaim = loaded ? loaded.size_vram : 0;
  const atCtx = loaded?.context_length === undefined ? "an unknown num_ctx (Ollama did not say)" : `num_ctx ${loaded.context_length}`;
  const freedFrom = r.ps.models.filter((m) => !sameModel(m.name, model) && (deps.reclaim ?? []).some((n) => sameModel(n, m.name)));
  const freed = freedFrom.reduce((sum, m) => sum + m.size_vram, 0);
  const notes = [
    ...(loaded ? [`free VRAM counts ${formatGb(reclaim)} held by the copy loaded at ${atCtx}, which Ollama replaces or reuses`] : []),
    ...(freedFrom.length > 0 ? [`free VRAM counts ${formatGb(freed)} held by ${freedFrom.map((m) => m.name).join(", ")}, which Ollama unloads to make room`] : []),
    ...(comfyBytes > 0 ? [`free VRAM counts ${formatGb(comfyBytes)} held by the app's idle ComfyUI, which the app stops to make room`] : []),
  ];
  if (estimate.rough !== undefined) notes.push(estimate.rough);
  const report = decideFit({
    model,
    numCtx,
    needBytes: estimate.need.totalBytes,
    freeVramBytes: r.gpu.freeBytes + reclaim + freed + comfyBytes,
    memAvailableBytes: r.memAvailableBytes,
    ...(deps.margins ? { margins: deps.margins } : {}),
    measuredAt: r.gpu.measuredAt,
    ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
  });
  return { report, gpu: r.gpu, memAvailableBytes: r.memAvailableBytes, estimate: estimate.need };
}

/**
 * What a model needs at `numCtx`. A model whose /api/show gives no geometry is sized the way a
 * download is, and `rough` says so: a missing field is no reason to keep it from chatting.
 */
function needAt(model: string, numCtx: number, weightsBytes: number, modelInfo: Readonly<Record<string, unknown>> | undefined, options: EstimateOptions | undefined): { need: NeedEstimate; rough?: string } {
  try {
    return { need: estimateNeed(model, numCtx, weightsBytes, parseArchInfo(model, modelInfo), options) };
  } catch (e) {
    if (!(e instanceof FitError) || e.code !== "model-info-incomplete") throw e;
    const kvCacheBytes = roughKvBytes(weightsBytes, numCtx);
    return {
      need: { model, numCtx, weightsBytes, kvCacheBytes, overheadBytes: RUNTIME_OVERHEAD_BYTES, totalBytes: weightsBytes + kvCacheBytes + RUNTIME_OVERHEAD_BYTES, kvLayers: 0 },
      rough: `rough estimate, /api/show gave no layer sizes (KV cache ${formatGb(kvCacheBytes)})`,
    };
  }
}

const roughKvBytes = (weightsBytes: number, numCtx: number) => Math.round(weightsBytes * PREDOWNLOAD_KV_FRACTION_PER_16K * (numCtx / KV_REFERENCE_CONTEXT));

/** Fit check for one model at one num_ctx; `report.numCtx` is the size it would run at. */
export async function checkFit(deps: FitDeps & { model: string; numCtx: number }): Promise<FitCheck> {
  return fitWithReadings(deps, deps.model, deps.numCtx, await takeReadings(deps));
}

export interface LoadPlan {
  /**
   * The fit with no busy turn stopped: every other resident model's VRAM counted as reclaimable
   * (Ollama unloads those first), and the app-owned ComfyUI's too when `comfy`.
   */
  report: FitReport;
  /** The busy models whose turns must stop for the load (only chat.send stopOthers stops them). */
  stop: string[];
  /** The plan stops the app-owned ComfyUI as well: without its memory the load does not fit in VRAM. */
  comfy: boolean;
}

/**
 * The one fit planner for a load of `model` at `numCtx`: the picker's and composer's fit.check,
 * preloads and chat.send. From one reading, it reclaims in this order: resident models not in
 * `busy` (no turn of this app uses them; their activity is unknown, see FitDeps.reclaim), then busy
 * models, the fewest and largest first, then the app-owned ComfyUI with MainPID `comfyPid` (its
 * nvidia-smi memory; when unlisted, `comfy` is a try with no busy turn). `busy` models are reclaimable only by stopping their
 * turns, which only chat.send does, so `report` never counts them. ComfyUI's stop claims the GPU
 * alone and so waits on every busy turn's chat claim: `report` counts it only when `busy` is empty,
 * and a plan that needs it with a busy turn running stops every busy turn first.
 *
 * `stop` is empty when the model is resident at this num_ctx, fits without any busy model, or
 * refuses even with every busy one and ComfyUI gone (stopping them would not help, and `comfy` is
 * false too); otherwise the busy ones whose VRAM makes it fit, or all of them when it needs ComfyUI
 * or only spills. The same model in `busy` never counts. Reads only; never loads or stops anything.
 */
export async function planLoad(deps: FitDeps & { model: string; numCtx: number; busy: readonly string[]; comfyPid?: number }): Promise<LoadPlan> {
  const r = await takeReadings(deps);
  // With no GPU there is no VRAM to reclaim from another reply or ComfyUI.
  if (r.gpu.gpuCount === 0) return { report: (await fitWithReadings(deps, deps.model, deps.numCtx, r)).report, stop: [], comfy: false };
  const others = r.ps.models.filter((m) => !sameModel(m.name, deps.model));
  const busy = deps.busy.filter((b) => !sameModel(b, deps.model));
  const isBusy = (name: string) => busy.some((b) => sameModel(b, name));
  const idle = others.filter((m) => !isBusy(m.name)).map((m) => m.name);
  const comfyBytes = deps.comfyPid === undefined ? 0 : r.gpu.tenants.filter((t) => t.pid === deps.comfyPid).reduce((sum, t) => sum + (t.usedBytes ?? 0), 0);
  const plan = async (stop: readonly string[], comfy: boolean) =>
    (await fitWithReadings({ ...deps, reclaim: [...idle, ...stop] }, deps.model, deps.numCtx, r, comfy ? comfyBytes : 0)).report;
  const alone = await plan([], false);
  if (alone.source === "measured" || alone.verdict === "fits") return { report: alone, stop: [], comfy: false };
  // ComfyUI with no nvidia-smi row (unlisted, or [N/A]): its memory is unknown, so the plan cannot
  // say stopping it helps; with no busy turn in the way, try (the caller stops it and plans again).
  const comfyListed = r.gpu.tenants.some((t) => t.pid === deps.comfyPid && t.usedBytes !== undefined);
  if (deps.comfyPid !== undefined && !comfyListed && busy.length === 0) return { report: alone, stop: [], comfy: true };
  const comfy = comfyBytes > 0;
  const comfyNow = comfy && busy.length === 0;
  const report = comfyNow ? await plan([], true) : alone;
  if (report.verdict === "fits") return { report, stop: [], comfy: comfyNow };
  const candidates = others
    .filter((m) => isBusy(m.name))
    .toSorted((a, b) => b.size_vram - a.size_vram)
    .map((m) => m.name);
  for (let n = 1; n <= candidates.length; n++) {
    if ((await plan(candidates.slice(0, n), false)).verdict === "fits") return { report, stop: candidates.slice(0, n), comfy: false };
  }
  // Every busy turn stopped (each holds a chat claim ComfyUI's stop waits on), and ComfyUI too.
  const last = candidates.length === 0 && !comfyNow ? alone : await plan(candidates, comfy);
  if (last.verdict === "refuse") return { report, stop: [], comfy: false };
  return { report, stop: comfy ? busy : candidates, comfy };
}

/** planLoad's `stop`: the busy models a load would push out. */
export const blockingModels = async (deps: FitDeps & { model: string; numCtx: number; busy: readonly string[] }): Promise<string[]> => (await planLoad(deps)).stop;

/** After a real load: the /api/ps size vs size_vram replaces the estimate. */
export async function measuredFit(deps: FitDeps & { model: string; numCtx: number }): Promise<FitCheck> {
  const [ps, gpu] = await untilAborted(
    Promise.all([fetchPs(deps.baseUrl, deps.signal), readGpu(deps.runNvidiaSmi ?? defaultNvidiaSmi, deps.now ?? Date.now, deps.signal)]),
    deps.signal,
  );
  const conflict = gpuReadingConflict(gpu.unavailableDetail, ps.models.map(model => model.size_vram));
  if (conflict !== undefined) throw new FitError("gpu-unreadable", conflict);
  const loaded = findLoaded(ps, deps.model);
  if (!loaded) throw new FitError("not-loaded", `${deps.model} is not in /api/ps; nothing to measure`);
  return { report: measuredReport(loaded, deps.numCtx, gpu, ps.models.length), gpu };
}

export interface ModelsFit {
  checks: FitCheck[];
  /** Models that run (fits or spills), best first: fits before spills, then least spill. */
  runnable: FitReport[];
  /** Set when nothing runs: names the closest model's shortfall in bytes and GB. */
  refusal?: string;
  gpu: GpuSnapshot;
}

/**
 * Fits every chat model in /api/tags at one num_ctx from a single GPU and
 * RAM reading. Models whose /api/show lists no "completion" capability
 * (embedding models) are skipped.
 */
export async function checkModels(deps: FitDeps & { numCtx: number; models?: readonly string[] }): Promise<ModelsFit> {
  const readings = await takeReadings(deps);
  const names = deps.models ?? readings.tags.models.map((m) => m.name);
  const checks: FitCheck[] = [];
  for (const name of names) {
    if (deps.models === undefined) {
      const show = await untilAborted(fetchShow(deps.baseUrl, name, deps.signal), deps.signal);
      if (show.capabilities && !show.capabilities.includes("completion")) continue;
    }
    checks.push(await fitWithReadings(deps, name, deps.numCtx, readings));
  }
  const runnable = checks
    .map((c) => c.report)
    .filter((r) => r.verdict !== "refuse")
    .toSorted((a, b) => (a.verdict === b.verdict ? a.spillRamBytes - b.spillRamBytes : a.verdict === "fits" ? -1 : 1));
  const result: ModelsFit = { checks, runnable, gpu: readings.gpu };
  if (runnable.length === 0) result.refusal = noModelFits(checks.map((c) => c.report), deps.numCtx);
  return result;
}

/**
 * One GPU and RAM reading, then a fit function that checks models one at a
 * time against it, for callers that stop early (the chat pick). A model
 * whose check fails gives undefined; the reading itself failing throws.
 */
export async function fitEach(deps: FitDeps & { numCtx: number }): Promise<(model: string) => Promise<FitReport | undefined>> {
  const readings = await takeReadings(deps);
  // The pick asks whether a model can run, not whether it runs beside what happens to be loaded:
  // a load unloads those first (planLoad), and the pick is cached without looking at what is loaded.
  const reclaim = readings.ps.models.map((m) => m.name);
  return async (model) => {
    try {
      return (await fitWithReadings({ ...deps, reclaim }, model, deps.numCtx, readings)).report;
    } catch {
      return undefined;
    }
  };
}

export interface FitSurvey {
  gpu: GpuSnapshot;
  memAvailableBytes: number;
  /** One report per model whose check ran; a model whose check failed (no /api/show geometry, say) is absent. */
  reports: Map<string, FitReport>;
}

/** Fits each named installed model at one num_ctx from a single GPU and RAM reading, skipping failures. */
export async function surveyFit(deps: FitDeps & { numCtx: number; models: readonly string[] }): Promise<FitSurvey> {
  const readings = await takeReadings(deps);
  const reports = new Map<string, FitReport>();
  for (const name of deps.models) {
    try {
      reports.set(name, (await fitWithReadings(deps, name, deps.numCtx, readings)).report);
    } catch {
      // This model gets no verdict; the others still do.
    }
  }
  return { gpu: readings.gpu, memAvailableBytes: readings.memAvailableBytes, reports };
}

/**
 * A rough fit for a model that is not downloaded yet, so there is no
 * /api/show geometry: weights are the download size, the KV cache is taken
 * as PREDOWNLOAD_KV_FRACTION_PER_16K of it per 16k tokens, plus the usual
 * overhead. Always source "estimate"; the message says it is pre-download.
 */
export function estimateBeforeDownload(input: {
  model: string;
  numCtx: number;
  downloadBytes: number;
  freeVramBytes: number;
  memAvailableBytes: number;
  measuredAt: number;
  margins?: Margins;
}): FitReport {
  const kv = roughKvBytes(input.downloadBytes, input.numCtx);
  return decideFit({
    model: input.model,
    numCtx: input.numCtx,
    needBytes: input.downloadBytes + kv + RUNTIME_OVERHEAD_BYTES,
    freeVramBytes: input.freeVramBytes,
    memAvailableBytes: input.memAvailableBytes,
    measuredAt: input.measuredAt,
    ...(input.margins ? { margins: input.margins } : {}),
    note: `rough estimate before download (weights from the ${formatGb(input.downloadBytes)} download, KV cache ${formatGb(kv)}, overhead ${formatGb(RUNTIME_OVERHEAD_BYTES)})`,
  });
}

export function noModelFits(reports: readonly FitReport[], numCtx: number): string {
  const short = reports
    .filter((r): r is FitReport & { shortfallBytes: number } => r.shortfallBytes !== undefined)
    .toSorted((a, b) => a.shortfallBytes - b.shortfallBytes);
  const closest = short[0];
  if (!closest) {
    return `No installed model runs at num_ctx ${numCtx}: ${reports.map((r) => r.message).join(" ") || "no chat models installed."}`;
  }
  return (
    `No installed model fits num_ctx ${numCtx}, even with RAM spill. The closest, ${closest.model}, ` +
    `is short by ${formatBytes(closest.shortfallBytes)}. ${closest.message ?? ""}`
  ).trim();
}
