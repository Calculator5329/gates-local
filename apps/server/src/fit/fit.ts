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
  NUM_CTX_FLOOR,
  PREDOWNLOAD_KV_FRACTION_PER_16K,
  RAM_SAFETY_MARGIN_BYTES,
  RUNTIME_OVERHEAD_BYTES,
  VRAM_SAFETY_MARGIN_BYTES,
} from "./constants.ts";
import { checkNumCtx, estimateNeed, parseArchInfo, type EstimateOptions } from "./estimate.ts";
import { formatBytes, formatGb } from "./format.ts";
import { defaultMeminfo, defaultNvidiaSmi, readGpu, readMemAvailable, untilAborted } from "./gpu.ts";
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

function ctxRefusal(model: string, numCtx: number, message: string, gpu: GpuSnapshot | undefined, now: number): FitReport {
  return {
    model,
    numCtx,
    freeVramBytes: gpu?.freeBytes ?? 0,
    needVramBytes: 0,
    spillRamBytes: 0,
    verdict: "refuse",
    source: "estimate",
    measuredAt: gpu?.measuredAt ?? now,
    message,
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
   * Resident models with no running turn (idle, or just stopped for this load): Ollama unloads an
   * idle model to make room, so the VRAM /api/ps says they hold counts as free for a cold plan.
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
  return { gpu, memAvailableBytes, ps, tags };
}

async function fitWithReadings(deps: FitDeps, model: string, numCtx: number, r: Readings): Promise<FitCheck> {
  const now = deps.now ?? Date.now;
  const loaded = findLoaded(r.ps, model);
  // Measured only when /api/ps proves the resident copy runs at this num_ctx. An Ollama that
  // leaves context_length out may hold it at a smaller one, so that copy is estimated like a cold one.
  if (loaded && loaded.context_length === numCtx) {
    return { report: measuredReport(loaded, numCtx, r.gpu, r.ps.models.length), gpu: r.gpu, memAvailableBytes: r.memAvailableBytes };
  }

  const tag = r.tags.models.find((m) => sameModel(m.name, model));
  if (!tag) throw new FitError("model-not-found", `${model} is not in /api/tags`);
  const show = await untilAborted(fetchShow(deps.baseUrl, model, deps.signal), deps.signal);
  const arch = parseArchInfo(model, show.model_info);
  const ctx = checkNumCtx(model, numCtx, arch.contextLength);
  if (!ctx.ok) {
    return { report: ctxRefusal(model, numCtx, ctx.message, r.gpu, now()), gpu: r.gpu, memAvailableBytes: r.memAvailableBytes };
  }
  const estimate = estimateNeed(model, numCtx, tag.size, arch, deps.estimate);

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
  ];
  const report = decideFit({
    model,
    numCtx,
    needBytes: estimate.totalBytes,
    freeVramBytes: r.gpu.freeBytes + reclaim + freed,
    memAvailableBytes: r.memAvailableBytes,
    ...(deps.margins ? { margins: deps.margins } : {}),
    measuredAt: r.gpu.measuredAt,
    ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
  });
  return { report, gpu: r.gpu, memAvailableBytes: r.memAvailableBytes, estimate };
}

/** Fit check for one model at one num_ctx. Refuses below the floor before touching anything. */
export async function checkFit(deps: FitDeps & { model: string; numCtx: number }): Promise<FitCheck> {
  const now = deps.now ?? Date.now;
  const floor = checkNumCtx(deps.model, deps.numCtx);
  if (!floor.ok) return { report: ctxRefusal(deps.model, deps.numCtx, floor.message, undefined, now()) };
  return fitWithReadings(deps, deps.model, deps.numCtx, await takeReadings(deps));
}

export interface LoadPlan {
  /** The fit with every idle resident model's VRAM counted as free (Ollama unloads those first). */
  report: FitReport;
  /** The busy models whose turns must stop for the load (see planLoad). */
  stop: string[];
}

/**
 * A load of `model` at `numCtx` beside the `busy` models (each with a running turn), from one
 * reading. Every other resident model is idle: Ollama unloads it to make room, so its VRAM counts
 * as free before any busy one. `stop` is empty when the model is resident at this num_ctx, fits
 * with the idle ones gone, or refuses even with every busy one gone too (stopping them would not
 * help); otherwise the fewest busy ones, largest first, whose VRAM makes it fit, or all of them
 * when it only spills. The same model in `busy` never counts. Reads only; never loads.
 */
export async function planLoad(deps: FitDeps & { model: string; numCtx: number; busy: readonly string[] }): Promise<LoadPlan> {
  const floor = checkNumCtx(deps.model, deps.numCtx);
  if (!floor.ok) return { report: ctxRefusal(deps.model, deps.numCtx, floor.message, undefined, (deps.now ?? Date.now)()), stop: [] };
  const r = await takeReadings(deps);
  const others = r.ps.models.filter((m) => !sameModel(m.name, deps.model));
  const isBusy = (name: string) => deps.busy.some((b) => sameModel(b, name));
  const idle = others.filter((m) => !isBusy(m.name)).map((m) => m.name);
  const plan = async (stop: readonly string[]) => (await fitWithReadings({ ...deps, reclaim: [...idle, ...stop] }, deps.model, deps.numCtx, r)).report;
  const report = await plan([]);
  if (report.source === "measured" || report.verdict === "fits") return { report, stop: [] };
  const candidates = others
    .filter((m) => isBusy(m.name))
    .toSorted((a, b) => b.size_vram - a.size_vram)
    .map((m) => m.name);
  for (let n = 1; n <= candidates.length; n++) {
    const verdict = (await plan(candidates.slice(0, n))).verdict;
    if (verdict === "fits") return { report, stop: candidates.slice(0, n) };
    if (n === candidates.length) return { report, stop: verdict === "refuse" ? [] : candidates };
  }
  return { report, stop: [] };
}

/** planLoad's `stop`: the busy models a load would push out. */
export const blockingModels = async (deps: FitDeps & { model: string; numCtx: number; busy: readonly string[] }): Promise<string[]> => (await planLoad(deps)).stop;

/** After a real load: the /api/ps size vs size_vram replaces the estimate. */
export async function measuredFit(deps: FitDeps & { model: string; numCtx: number }): Promise<FitCheck> {
  const [ps, gpu] = await untilAborted(
    Promise.all([fetchPs(deps.baseUrl, deps.signal), readGpu(deps.runNvidiaSmi ?? defaultNvidiaSmi, deps.now ?? Date.now, deps.signal)]),
    deps.signal,
  );
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
    const floor = checkNumCtx(name, deps.numCtx);
    if (!floor.ok) {
      checks.push({ report: ctxRefusal(name, deps.numCtx, floor.message, readings.gpu, readings.gpu.measuredAt) });
      continue;
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
  const kv = Math.round(input.downloadBytes * PREDOWNLOAD_KV_FRACTION_PER_16K * (input.numCtx / NUM_CTX_FLOOR));
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
    return `No installed model runs at num_ctx ${numCtx} (floor ${NUM_CTX_FLOOR}): ${reports.map((r) => r.message).join(" ") || "no chat models installed."}`;
  }
  return (
    `No installed model fits num_ctx ${numCtx}, even with RAM spill. The closest, ${closest.model}, ` +
    `is short by ${formatBytes(closest.shortfallBytes)}. ${closest.message ?? ""}`
  ).trim();
}
