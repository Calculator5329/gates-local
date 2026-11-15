import { fitWords, type FitWords } from "@gates-local/contracts";
import {
  KV_REFERENCE_CONTEXT,
  PREDOWNLOAD_KV_FRACTION_PER_16K,
  RAM_SAFETY_MARGIN_BYTES,
  RUNTIME_OVERHEAD_BYTES,
  SYSTEM_RAM_RESERVE_BYTES,
  VRAM_SAFETY_MARGIN_BYTES,
} from "./constants.ts";
import type { GpuBaseline } from "./baseline.ts";
import { effectiveNumCtx, estimateNeed, parseArchInfo, reportedContextLength, type EstimateOptions } from "./estimate.ts";
import { formatBytes, formatGb } from "./format.ts";
import { defaultMeminfo, defaultNvidiaSmi, gpuReadingConflict, readGpu, readMemory, untilAborted } from "./gpu.ts";
import { fetchPs, fetchShow, fetchTags, findLoaded, isCopyOf, sameModel, type PsEntry, type PsResponse, type ShowResponse, type TagsResponse } from "./ollama.ts";
import { hasPerLayerTable, offCardBytes } from "./off-card.ts";
import { holdsOneAt } from "./one-model.ts";
import {
  FitError,
  type FitReport,
  type GpuSnapshot,
  type MeminfoReader,
  type NeedEstimate,
  type NvidiaSmiRunner,
} from "./types.ts";

declare const totalNeed: unique symbol;
// why: branded so a fit table row can only hold a GPU plus system memory total.
export type TotalNeed = number & { readonly [totalNeed]: true };
export type TotalReport = Omit<FitReport, "needVramBytes"> & { readonly needVramBytes: TotalNeed };

export const estimatedNeed = (need: NeedEstimate): TotalNeed => need.totalBytes as TotalNeed;

// why: every context of one model moves by the same offset, so a larger one never needs less.
export const offsetNeed = (need: NeedEstimate, offset: number): TotalNeed => Math.max(need.weightsBytes, need.totalBytes + offset) as TotalNeed;

// external: Ollama can leave weights it maps from disk for the processor out of /api/ps size, so size_vram >= size alone does not prove a copy is wholly on the GPU.
export function measuredNeed(entry: PsEntry, runnerBytes: number | undefined, weightsBytes: number): TotalNeed | undefined {
  const held = Math.max(entry.size_vram, runnerBytes ?? 0);
  const whollyOnGpu = entry.size_vram >= entry.size && held >= weightsBytes;
  return whollyOnGpu ? (held as TotalNeed) : undefined;
}

function runnerBytesOf(gpu: GpuSnapshot, loadedCount: number): number | undefined {
  const runners = gpu.tenants.filter((t) => t.role === "ollama" && t.usedBytes !== undefined);
  // why: the runners' memory is one model's only when exactly one is loaded.
  return loadedCount === 1 && runners.length > 0 ? runners.reduce((sum, t) => sum + (t.usedBytes ?? 0), 0) : undefined;
}

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
  note?: string;
}

export type FitBasis = FitWords["basis"];

export type CardReading = Pick<GpuSnapshot, "gpuCount" | "freeBytes" | "totalBytes" | "measuredAt" | "cards">;

// external: Ollama splits a model that does not fit on one card across all of them, keeps a minimum free on each and never splits a layer across two, and each card it uses holds its own CUDA context and runner scratch.
export function cardMargins(margins: Margins, gpu: Pick<GpuSnapshot, "cards">, basis: FitBasis): { margins: Margins; extraBytes: number; extraCards: number } {
  // why: each card after the largest gives up the margin too, never more than it has.
  const extra = (gpu.cards ?? []).slice(1).map((c) => Math.min(margins.vramMarginBytes, basis === "card" ? c.totalBytes : c.freeBytes));
  const extraBytes = extra.reduce((sum, b) => sum + b, 0);
  return { margins: extraBytes === 0 ? margins : { ...margins, vramMarginBytes: margins.vramMarginBytes + extraBytes }, extraBytes, extraCards: extra.length };
}

export const cardFreeBytes = (gpu: CardReading): number => (gpu.gpuCount === 0 ? gpu.freeBytes : Math.max(gpu.freeBytes, gpu.totalBytes));

// why: a model the runner lists on a card is worded as on it, even when the app cannot read it.
export const worded = <R extends FitReport>(report: R, basis: FitBasis, gpu: Pick<GpuSnapshot, "gpuCount">, onCard = false): R => ({ ...report, words: fitWords(report, basis, gpu.gpuCount === 0 && !onCard) });

export interface JudgeInput {
  model: string;
  numCtx: number;
  needBytes: number;
  gpu: CardReading;
  memTotalBytes: number;
  freeVramBytes?: number;
  memAvailableBytes?: number;
  margins?: Margins;
  note?: string;
  onCard?: boolean;
}

export function judge(basis: FitBasis, input: JudgeInput): FitReport {
  const nowVram = input.freeVramBytes ?? input.gpu.freeBytes;
  const ram = cardRamBytes(input.memTotalBytes);
  const cards = cardMargins(input.margins ?? DEFAULT_MARGINS, input.gpu, basis);
  const cardsNote = cards.extraBytes === 0 ? undefined : `${formatGb(cards.extraBytes)} of the margin for ${cards.extraCards} more GPU${cards.extraCards === 1 ? "" : "s"}`;
  const note = [input.note, cardsNote].filter((n) => n !== undefined).join("; ");
  const report = decideFit({
    model: input.model,
    numCtx: input.numCtx,
    needBytes: input.needBytes,
    freeVramBytes: basis === "card" ? Math.max(cardFreeBytes(input.gpu), nowVram) : nowVram,
    // why: what others hold now is the system's to page out, so never less than the computer has.
    memAvailableBytes: basis === "card" ? ram : Math.max(input.memAvailableBytes ?? 0, ram),
    measuredAt: input.gpu.measuredAt,
    ...(input.margins || cards.extraBytes > 0 ? { margins: cards.margins } : {}),
    ...(note === "" ? {} : { note }),
  });
  return worded(report, basis, input.gpu, input.onCard === true);
}

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

// external: Ollama's /api/ps leaves the runner's CUDA context and scratch out of size_vram: a 9B model it listed at 5.92 GB held 6926 MiB by nvidia-smi.
export function measuredReport(model: string, entry: PsEntry, numCtx: number, gpu: GpuSnapshot, loadedCount = 1): FitReport {
  const spill = Math.max(0, entry.size - entry.size_vram);
  const ctx = entry.context_length ?? numCtx;
  const runnerBytes = runnerBytesOf(gpu, loadedCount);
  const vram = Math.max(entry.size_vram, runnerBytes ?? 0);
  const runnerNote =
    runnerBytes === undefined
      ? "runner VRAM not attributable (nvidia-smi shows no single runner)"
      : `runner holds ${formatGb(runnerBytes)} on the GPU per nvidia-smi`;
  return worded({
    model,
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
  }, "now", gpu, entry.size_vram > 0);
}

export interface FitDeps {
  baseUrl: string;
  runNvidiaSmi?: NvidiaSmiRunner;
  readMeminfo?: MeminfoReader;
  now?: () => number;
  margins?: Margins;
  estimate?: EstimateOptions;
  signal?: AbortSignal;
  reuseGpuMs?: number;
  // external: Ollama unloads a model it is not serving to make room, and queues the load while another of its clients uses one.
  reclaim?: readonly string[];
  holdsOne?: boolean;
  baseline?: GpuBaseline;
}

export interface FitCheck {
  report: TotalReport;
  resident?: boolean;
  gpu?: GpuSnapshot;
  memAvailableBytes?: number;
  estimate?: NeedEstimate;
}

export interface Readings {
  gpu: GpuSnapshot;
  memAvailableBytes: number;
  memTotalBytes: number;
  ps: PsResponse;
  tags: TagsResponse;
  shows: Map<string, Promise<ShowResponse>>;
}

export async function takeReadings(deps: FitDeps): Promise<Readings> {
  const now = deps.now ?? Date.now;
  const { signal } = deps;
  const [gpu, { availableBytes: memAvailableBytes, totalBytes: memTotalBytes }, ps, tags] = await untilAborted(
    Promise.all([
      readGpu(deps.runNvidiaSmi ?? defaultNvidiaSmi, now, signal, deps.reuseGpuMs),
      readMemory(deps.readMeminfo ?? defaultMeminfo, signal),
      fetchPs(deps.baseUrl, signal),
      fetchTags(deps.baseUrl, signal),
    ]),
    signal,
  );
  const conflict = gpuReadingConflict(gpu.unavailableDetail, ps.models.map(model => model.size_vram));
  if (conflict !== undefined) throw new FitError("gpu-unreadable", conflict);
  return { gpu, memAvailableBytes, memTotalBytes, ps, tags, shows: new Map() };
}

export function showOf(deps: FitDeps, r: Readings, model: string): Promise<ShowResponse> {
  const key = r.tags.models.find((m) => sameModel(m.name, model))?.name ?? model;
  let show = r.shows.get(key);
  if (show === undefined) {
    show = untilAborted(fetchShow(deps.baseUrl, model, deps.signal), deps.signal);
    r.shows.set(key, show);
    // why: a failed answer is not kept, so the next call asks again.
    show.catch(() => r.shows.delete(key));
  }
  return show;
}

export async function fitWithReadings(deps: FitDeps, model: string, requested: number, r: Readings): Promise<FitCheck> {
  const loaded = findLoaded(r.ps, model);
  const tag = r.tags.models.find((m) => sameModel(m.name, model));
  // external: an Ollama that leaves context_length out of /api/ps may hold the copy at a smaller context, so only a copy listed at this num_ctx is measured.
  const measured = (numCtx: number, weights = tag?.size ?? 0): FitCheck | undefined => {
    if (!loaded || loaded.context_length !== numCtx) return undefined;
    // why: a copy /api/tags does not list has weights 0, so nothing spilled is the only proof.
    const need = measuredNeed(loaded, runnerBytesOf(r.gpu, r.ps.models.length), weights);
    if (need === undefined) return undefined;
    return { report: { ...measuredReport(model, loaded, numCtx, r.gpu, r.ps.models.length), needVramBytes: need }, resident: true, gpu: r.gpu, memAvailableBytes: r.memAvailableBytes };
  };
  const now = measured(requested);
  if (now) return now;
  if (!tag) throw new FitError("model-not-found", `${model} is not in /api/tags`);

  const show = await showOf(deps, r, model);
  const numCtx = effectiveNumCtx(requested, reportedContextLength(show.model_info));
  const onCard = r.gpu.gpuCount > 0;
  const offCard = onCard && hasPerLayerTable(show.model_info) ? await untilAborted(offCardBytes(deps.baseUrl, model, tag.digest ?? tag.name, deps.signal), deps.signal) : undefined;
  const weights = Math.max(0, tag.size - (offCard ?? 0));
  const atMax = numCtx === requested && offCard === undefined ? undefined : measured(numCtx, weights);
  if (atMax) return atMax;
  const estimate = needAt(model, numCtx, weights, show.model_info, deps.estimate);
  const runnerBytes = runnerBytesOf(r.gpu, r.ps.models.length);
  const loadedCtx = loaded?.context_length;
  const held = loaded ? Math.max(loaded.size_vram, runnerBytes ?? 0) : 0;
  const atLoaded = loaded && loadedCtx !== undefined ? needAt(model, loadedCtx, weights, show.model_info, deps.estimate).need : undefined;
  const measuredLoaded = loaded && atLoaded ? measuredNeed(loaded, runnerBytes, weights) : undefined;
  const offset = measuredLoaded === undefined || atLoaded === undefined ? 0 : measuredLoaded - atLoaded.totalBytes;
  const need = offsetNeed(estimate.need, offset);

  // why: loaded at this num_ctx it runs as it is, partly in system memory, so it is never refused.
  if (loaded && loaded.context_length === numCtx) {
    const spill = Math.max(0, need - held);
    return {
      report: worded({
        model, numCtx, freeVramBytes: r.gpu.freeBytes + held, needVramBytes: need, spillRamBytes: spill,
        verdict: spill > 0 ? "spills" : "fits", source: "estimate", measuredAt: r.gpu.measuredAt,
        message: `${model} is loaded at num_ctx ${numCtx} with ${formatGb(held)} on the GPU and the rest in system memory; it needs ${formatGb(need)} in all (estimate).`,
      }, "now", r.gpu, held > 0),
      resident: true, gpu: r.gpu, memAvailableBytes: r.memAvailableBytes, estimate: estimate.need,
    };
  }

  // external: Ollama replaces a copy loaded at another num_ctx on the next request, and replaces or reuses one whose context it does not state, so what the copy holds counts as free.
  const reclaim = loaded ? loaded.size_vram : 0;
  // external: weights Ollama maps from disk are page cache, so above the loaded context only what /api/ps counts outside the GPU frees with the copy.
  const smaller = loadedCtx !== undefined && numCtx <= loadedCtx && atLoaded !== undefined;
  // why: up to the loaded context its own row's share frees too, so a smaller one is never refused.
  const ramReclaim = loaded ? Math.max(loaded.size - loaded.size_vram, smaller ? offsetNeed(atLoaded, offset) - held : 0, 0) : 0;
  const ramNow = r.memAvailableBytes + ramReclaim;
  const atCtx = loaded?.context_length === undefined ? "an unknown num_ctx (Ollama did not say)" : `num_ctx ${loaded.context_length}`;
  const freedFrom = r.ps.models.filter((m) => !isCopyOf(m, model) && (deps.reclaim ?? []).some((n) => sameModel(n, m.name)));
  const freed = freedFrom.reduce((sum, m) => sum + m.size_vram, 0);
  const notes = [
    ...(loaded ? [`free VRAM counts ${formatGb(reclaim)} held by the copy loaded at ${atCtx}, which Ollama replaces or reuses`] : []),
    ...(freedFrom.length > 0 ? [`free VRAM counts ${formatGb(freed)} held by ${freedFrom.map((m) => m.name).join(", ")}, which leave${freedFrom.length === 1 ? "s" : ""} to make room`] : []),
  ];
  if (estimate.rough !== undefined) notes.push(estimate.rough);
  if (offCard !== undefined) notes.push(`its per-layer table (${formatGb(offCard)}) stays in system memory and is not counted on the GPU`);
  if (cardRamBytes(r.memTotalBytes) > ramNow) notes.push(`system RAM counts what this computer has; ${formatGb(ramNow)} is free now`);
  const report = judge("now", {
    model,
    numCtx,
    needBytes: need,
    gpu: r.gpu,
    memTotalBytes: r.memTotalBytes,
    freeVramBytes: r.gpu.freeBytes + reclaim + freed,
    memAvailableBytes: ramNow,
    ...(deps.margins ? { margins: deps.margins } : {}),
    ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
    ...((loaded?.size_vram ?? 0) > 0 ? { onCard: true } : {}),
  });
  // why: a refusal carries the system memory it was decided from, beside its free VRAM.
  const reading = report.verdict === "refuse" ? { memAvailableBytes: r.memAvailableBytes } : {};
  return { report: { ...report, needVramBytes: need, ...reading }, gpu: r.gpu, memAvailableBytes: r.memAvailableBytes, estimate: estimate.need };
}

function needAt(model: string, numCtx: number, weightsBytes: number, modelInfo: Readonly<Record<string, unknown>> | undefined, options: EstimateOptions | undefined): { need: NeedEstimate; rough?: string } {
  try {
    return { need: estimateNeed(model, numCtx, weightsBytes, parseArchInfo(model, modelInfo), options) };
  } catch (e) {
    // why: a missing field is no reason to keep a model from chatting; it is sized as a download is.
    if (!(e instanceof FitError) || e.code !== "model-info-incomplete") throw e;
    const kvCacheBytes = roughKvBytes(weightsBytes, numCtx);
    return {
      need: { model, numCtx, weightsBytes, kvCacheBytes, overheadBytes: RUNTIME_OVERHEAD_BYTES, totalBytes: weightsBytes + kvCacheBytes + RUNTIME_OVERHEAD_BYTES, kvLayers: 0 },
      rough: `rough estimate, /api/show gave no layer sizes (KV cache ${formatGb(kvCacheBytes)})`,
    };
  }
}

const roughKvBytes = (weightsBytes: number, numCtx: number) => Math.round(weightsBytes * PREDOWNLOAD_KV_FRACTION_PER_16K * (numCtx / KV_REFERENCE_CONTEXT));

export async function checkFit(deps: FitDeps & { model: string; numCtx: number }): Promise<FitCheck> {
  return fitWithReadings(deps, deps.model, deps.numCtx, await takeReadings(deps));
}

export interface LoadPlan {
  report: TotalReport;
  stop: string[];
}

export async function planLoad(deps: FitDeps & { model: string; numCtx: number; busy: readonly string[]; measured?: boolean }): Promise<LoadPlan> {
  return planWith(deps, await takeReadings(deps));
}

export async function planWith(deps: FitDeps & { model: string; numCtx: number; busy: readonly string[]; measured?: boolean }, r: Readings): Promise<LoadPlan> {
  const others = r.ps.models.filter((m) => !isCopyOf(m, deps.model));
  const busy = deps.busy.filter((b) => !sameModel(b, deps.model));
  const isBusy = (name: string) => busy.some((b) => sameModel(b, name));
  const candidates = others
    .filter((m) => isBusy(m.name))
    .toSorted((a, b) => b.size_vram - a.size_vram)
    .map((m) => m.name);
  // external: an Ollama that holds one model unloads the idle ones itself at a load and waits for a busy one's reply to end.
  const holdsOneModel = deps.holdsOne ?? holdsOneAt(deps.baseUrl);
  const onCard = r.gpu.gpuCount > 0;
  // why: nothing leaves with no GPU, or once a handoff has already asked the idle ones to go.
  const leaving = !onCard || (deps.measured === true && !holdsOneModel) ? [] : others.filter((m) => !isBusy(m.name)).map((m) => m.name);
  const fit = (stop: readonly string[]) => fitWithReadings(onCard ? { ...deps, reclaim: [...leaving, ...stop] } : deps, deps.model, deps.numCtx, r);
  const first = await fit([]);
  if (first.resident === true || candidates.length === 0) return { report: first.report, stop: [] };
  const gone = (await fit(candidates)).report;
  // why: refused even with every busy reply gone, so stopping them would not help.
  if (gone.verdict === "refuse") return { report: first.report, stop: [] };
  return { report: gone, stop: candidates };
}

export const blockingModels = async (deps: FitDeps & { model: string; numCtx: number; busy: readonly string[] }): Promise<string[]> => (await planLoad(deps)).stop;

export async function measuredFit(deps: FitDeps & { model: string; numCtx: number }): Promise<{ report: FitReport; gpu: GpuSnapshot }> {
  const [ps, gpu] = await untilAborted(
    Promise.all([fetchPs(deps.baseUrl, deps.signal), readGpu(deps.runNvidiaSmi ?? defaultNvidiaSmi, deps.now ?? Date.now, deps.signal)]),
    deps.signal,
  );
  const conflict = gpuReadingConflict(gpu.unavailableDetail, ps.models.map(model => model.size_vram));
  if (conflict !== undefined) throw new FitError("gpu-unreadable", conflict);
  const loaded = findLoaded(ps, deps.model);
  if (!loaded) throw new FitError("not-loaded", `${deps.model} is not in /api/ps; nothing to measure`);
  return { report: measuredReport(deps.model, loaded, deps.numCtx, gpu, ps.models.length), gpu };
}

export interface ModelsFit {
  checks: FitCheck[];
  runnable: FitReport[];
  refusal?: string;
  gpu: GpuSnapshot;
}

export async function checkModels(deps: FitDeps & { numCtx: number; models?: readonly string[] }): Promise<ModelsFit> {
  const readings = await takeReadings(deps);
  const names = deps.models ?? readings.tags.models.map((m) => m.name);
  const checks: FitCheck[] = [];
  for (const name of names) {
    if (deps.models === undefined) {
      const show = await untilAborted(fetchShow(deps.baseUrl, name, deps.signal), deps.signal);
      const embeddingOnly = show.capabilities && !show.capabilities.includes("completion");
      if (embeddingOnly) continue;
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

export async function fitEach(deps: FitDeps & { numCtx: number }): Promise<(model: string) => Promise<FitReport | undefined>> {
  const readings = await takeReadings(deps);
  // why: the pick asks whether a model can run at all; a load unloads the loaded ones first.
  const reclaim = readings.ps.models.map((m) => m.name);
  return async (model) => {
    try {
      return (await fitWithReadings({ ...deps, reclaim }, model, deps.numCtx, readings)).report;
    } catch {
      // why: a model whose check fails has no report.
      return undefined;
    }
  };
}

export interface FitSurvey {
  gpu: GpuSnapshot;
  memAvailableBytes: number;
  memTotalBytes: number;
  reports: Map<string, FitReport>;
}

export const cardRamBytes = (memTotalBytes: number): number => Math.max(0, memTotalBytes - SYSTEM_RAM_RESERVE_BYTES);

export async function surveyFit(deps: FitDeps & { numCtx: number; models: readonly string[] }): Promise<FitSurvey> {
  const readings = await takeReadings(deps);
  const reports = new Map<string, FitReport>();
  for (const name of deps.models) {
    // why: a model whose check fails gets no verdict; the others still do.
    const report = await fitWithReadings(deps, name, deps.numCtx, readings).then((check) => check.report, () => undefined);
    if (report !== undefined) reports.set(name, report);
  }
  return { gpu: readings.gpu, memAvailableBytes: readings.memAvailableBytes, memTotalBytes: readings.memTotalBytes, reports };
}

export function estimateBeforeDownload(input: {
  model: string;
  numCtx: number;
  downloadBytes: number;
  gpu: CardReading;
  memTotalBytes: number;
  margins?: Margins;
}): TotalReport {
  const kv = roughKvBytes(input.downloadBytes, input.numCtx);
  const need = preDownloadNeed(input.downloadBytes, input.numCtx);
  const report = judge("card", {
    model: input.model,
    numCtx: input.numCtx,
    needBytes: need,
    gpu: input.gpu,
    memTotalBytes: input.memTotalBytes,
    ...(input.margins ? { margins: input.margins } : {}),
    note: `rough estimate before download (weights from the ${formatGb(input.downloadBytes)} download, KV cache ${formatGb(kv)}, overhead ${formatGb(RUNTIME_OVERHEAD_BYTES)})`,
  });
  return { ...report, needVramBytes: need };
}

export const preDownloadNeed = (downloadBytes: number, numCtx: number): TotalNeed =>
  (downloadBytes + roughKvBytes(downloadBytes, numCtx) + RUNTIME_OVERHEAD_BYTES) as TotalNeed;

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
