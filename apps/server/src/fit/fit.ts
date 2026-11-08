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
import { defaultMeminfo, defaultNvidiaSmi, readGpu, readMemAvailable } from "./gpu.ts";
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

function ctxRefusal(model: string, numCtx: number, message: string, gpu: GpuSnapshot | undefined, now: number, contextLimit?: number): FitReport {
  return {
    ...(contextLimit === undefined ? {} : { contextLimit }),
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
  const [gpu, memAvailableBytes, ps, tags] = await Promise.all([
    readGpu(deps.runNvidiaSmi ?? defaultNvidiaSmi, now),
    readMemAvailable(deps.readMeminfo ?? defaultMeminfo),
    fetchPs(deps.baseUrl),
    fetchTags(deps.baseUrl),
  ]);
  return { gpu, memAvailableBytes, ps, tags };
}

async function fitWithReadings(deps: FitDeps, model: string, numCtx: number, r: Readings): Promise<FitCheck> {
  const now = deps.now ?? Date.now;
  const loaded = findLoaded(r.ps, model);
  if (loaded && (loaded.context_length === undefined || loaded.context_length === numCtx)) {
    return { report: measuredReport(loaded, numCtx, r.gpu, r.ps.models.length), gpu: r.gpu, memAvailableBytes: r.memAvailableBytes };
  }

  const tag = r.tags.models.find((m) => sameModel(m.name, model));
  if (!tag) throw new FitError("model-not-found", `${model} is not in /api/tags`);
  const show = await fetchShow(deps.baseUrl, model);
  const arch = parseArchInfo(model, show.model_info);
  const ctx = checkNumCtx(model, numCtx, arch.contextLength);
  if (!ctx.ok) {
    // Past the model's own ceiling (not below the floor): say the most it supports.
    const limit = arch.contextLength !== undefined && numCtx > arch.contextLength ? arch.contextLength : undefined;
    return { report: ctxRefusal(model, numCtx, ctx.message, r.gpu, now(), limit), gpu: r.gpu, memAvailableBytes: r.memAvailableBytes };
  }
  const estimate = estimateNeed(model, numCtx, tag.size, arch, deps.estimate);

  // A copy loaded at another num_ctx is replaced by Ollama on the next
  // request, and other loaded models are unloaded to make room, so the VRAM
  // they hold counts as free for this plan.
  const reclaim = loaded ? loaded.size_vram : 0;
  const others = r.ps.models.filter((m) => !sameModel(m.name, model));
  const reclaimOthers = others.reduce((sum, m) => sum + m.size_vram, 0);
  const notes = [
    ...(loaded ? [`${formatGb(reclaim)} held by the copy loaded at num_ctx ${loaded.context_length}, which Ollama replaces`] : []),
    ...(others.length > 0 ? [`${formatGb(reclaimOthers)} held by ${others.map((m) => m.name).join(", ")}, which Ollama unloads to make room`] : []),
  ];
  const report = decideFit({
    model,
    numCtx,
    needBytes: estimate.totalBytes,
    freeVramBytes: r.gpu.freeBytes + reclaim + reclaimOthers,
    memAvailableBytes: r.memAvailableBytes,
    ...(deps.margins ? { margins: deps.margins } : {}),
    measuredAt: r.gpu.measuredAt,
    ...(notes.length > 0 ? { note: `free VRAM counts ${notes.join("; ")}` } : {}),
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

/** After a real load: the /api/ps size vs size_vram replaces the estimate. */
export async function measuredFit(deps: FitDeps & { model: string; numCtx: number }): Promise<FitCheck> {
  const [ps, gpu] = await Promise.all([
    fetchPs(deps.baseUrl),
    readGpu(deps.runNvidiaSmi ?? defaultNvidiaSmi, deps.now ?? Date.now),
  ]);
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
      const show = await fetchShow(deps.baseUrl, name);
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

/**
 * One GPU and RAM reading, then a fit function that checks models one at a
 * time against it, for callers that stop early (the chat pick). A model
 * whose check fails gives undefined; the reading itself failing throws.
 */
export async function fitEach(deps: FitDeps & { numCtx: number }): Promise<(model: string) => Promise<FitReport | undefined>> {
  const now = deps.now ?? Date.now;
  const readings = await takeReadings(deps);
  return async (model) => {
    const floor = checkNumCtx(model, deps.numCtx);
    if (!floor.ok) return ctxRefusal(model, deps.numCtx, floor.message, readings.gpu, now());
    try {
      return (await fitWithReadings(deps, model, deps.numCtx, readings)).report;
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
