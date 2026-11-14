// The fit check: measured free VRAM (with whisper and every other tenant
// already counted by nvidia-smi) against a model's need at a num_ctx.
//
// fits    need <= free VRAM - VRAM margin
// spills  the overflow fits in MemAvailable - RAM margin; spillRamBytes shown
// refuse  otherwise, with shortfallBytes and a message naming the numbers
//
// A download size alone never proves a fit: the estimate adds KV cache and
// overhead, and a measured /api/ps report replaces it after a real load.
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
/**
 * What a model needs at a context in all, GPU plus system memory: the one basis the fit table
 * states. Only estimatedNeed, preDownloadNeed and measuredNeed make one.
 */
export type TotalNeed = number & { readonly [totalNeed]: true };
/** A report whose need is a TotalNeed: the only kind a fit table row is made from. */
export type TotalReport = Omit<FitReport, "needVramBytes"> & { readonly needVramBytes: TotalNeed };

export const estimatedNeed = (need: NeedEstimate): TotalNeed => need.totalBytes as TotalNeed;

/**
 * The estimate on a loaded model's basis: moved by `offset` (its copy's measurement minus the
 * estimate at the copy's context, or 0 when it has none), and never below the weights. Every context
 * of one model moves by the same offset, so a larger context never needs less.
 */
export const offsetNeed = (need: NeedEstimate, offset: number): TotalNeed => Math.max(need.weightsBytes, need.totalBytes + offset) as TotalNeed;

/**
 * A loaded copy's measurement on the estimate's basis, or undefined when it measures something
 * else. It counts only when the copy is wholly on the GPU: /api/ps says nothing is in system memory
 * (size_vram >= size), and what it holds on the GPU (size_vram, or the runner's nvidia-smi memory
 * when larger) is at least the model's weights. A runtime that maps the CPU part of the weights
 * from disk can leave them out of `size`, so size_vram alone does not prove that.
 */
export function measuredNeed(entry: PsEntry, runnerBytes: number | undefined, weightsBytes: number): TotalNeed | undefined {
  const held = Math.max(entry.size_vram, runnerBytes ?? 0);
  return entry.size_vram >= entry.size && held >= weightsBytes ? (held as TotalNeed) : undefined;
}

/** The runner processes' nvidia-smi memory, when exactly one model is loaded and so owns it. */
function runnerBytesOf(gpu: GpuSnapshot, loadedCount: number): number | undefined {
  const runners = gpu.tenants.filter((t) => t.role === "ollama" && t.usedBytes !== undefined);
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
  /** Prefix for the message, e.g. why free VRAM was adjusted. */
  note?: string;
}

/**
 * What a verdict is judged against. "card": the card's own memory and the system memory the
 * computer has, whatever other programs hold right now (every list and Settings). "now": what a
 * load would have right now (a send, the composer).
 */
export type FitBasis = FitWords["basis"];

/** What a verdict needs of a GPU reading. */
export type CardReading = Pick<GpuSnapshot, "gpuCount" | "freeBytes" | "totalBytes" | "measuredAt">;

/** The card's own GPU memory, whatever other programs hold: the whole card; with no GPU, what is free. */
export const cardFreeBytes = (gpu: CardReading): number => (gpu.gpuCount === 0 ? gpu.freeBytes : Math.max(gpu.freeBytes, gpu.totalBytes));

/** A report with its words, on the basis it was judged on. */
export const worded = <R extends FitReport>(report: R, basis: FitBasis, gpu: Pick<GpuSnapshot, "gpuCount">): R => ({ ...report, words: fitWords(report, basis, gpu.gpuCount === 0) });

export interface JudgeInput {
  model: string;
  numCtx: number;
  needBytes: number;
  /** The reading: the card's size and the computer's memory come from it. */
  gpu: CardReading;
  memTotalBytes: number;
  /** GPU memory a load would have right now: free plus what leaves for it. Absent: what is free. */
  freeVramBytes?: number;
  /** System memory a load would have right now: available plus what leaves with it. The "now" basis needs it. */
  memAvailableBytes?: number;
  margins?: Margins;
  note?: string;
}

/**
 * The one place the server judges a fit, on either basis, from one reading, with its words.
 * now: GPU memory free plus what leaves for the load; system memory never below what the computer
 * has (cardRamBytes): memory other programs hold at this instant is the system's to page out, and
 * refusing on it kept every model that runs partly in system memory from loading on a 16 GB
 * computer (WIN-MEM-01 and 02). card: the whole card, or more when what leaves for the load is
 * more (no GPU), and the system memory the computer has.
 */
export function judge(basis: FitBasis, input: JudgeInput): FitReport {
  const nowVram = input.freeVramBytes ?? input.gpu.freeBytes;
  const ram = cardRamBytes(input.memTotalBytes);
  const report = decideFit({
    model: input.model,
    numCtx: input.numCtx,
    needBytes: input.needBytes,
    freeVramBytes: basis === "card" ? Math.max(cardFreeBytes(input.gpu), nowVram) : nowVram,
    memAvailableBytes: basis === "card" ? ram : Math.max(input.memAvailableBytes ?? 0, ram),
    measuredAt: input.gpu.measuredAt,
    ...(input.margins ? { margins: input.margins } : {}),
    ...(input.note === undefined ? {} : { note: input.note }),
  });
  return worded(report, basis, input.gpu);
}

/** Pure verdict from an estimated need and measured free memory: judge's arithmetic, with no words. */
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
    // The model asked about: /api/ps may list the copy under another name for it.
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
  }, "now", gpu);
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
  /** A survey (the fit table) may take a GPU reading this many ms old (gpu.ts GPU_REUSE_MS); a send never does. */
  reuseGpuMs?: number;
  /**
   * Resident models no turn of this app is using (or whose turn was just stopped for this load):
   * Ollama unloads a model it is not serving to make room, so the VRAM /api/ps says they hold
   * counts as reclaimable for a cold plan. Their activity is unknown: another client of the same
   * Ollama may be using one, and Ollama then queues the load until it is done.
   */
  reclaim?: readonly string[];
  /**
   * The Ollama at `baseUrl` holds one model at a time and replaces it itself when another loads
   * (RuntimeStatus.holdsOne). Absent: as one-model.ts holdsOneAt answers for `baseUrl`.
   */
  holdsOne?: boolean;
  /**
   * The card's own memory, and who uses it right now (baseline.ts): every list judges against
   * it. A send never reads it; absent, the lists judge right now too.
   */
  baseline?: GpuBaseline;
}

export interface FitCheck {
  report: TotalReport;
  /** The model is loaded at this num_ctx: it runs as it is, and a send needs no load. */
  resident?: boolean;
  /** The GPU reading the verdict used, tenants named (whisper permanent). */
  gpu?: GpuSnapshot;
  memAvailableBytes?: number;
  estimate?: NeedEstimate;
}

/** One GPU, memory and runtime reading. Every fit computed from it shares its /api/show answers. */
export interface Readings {
  gpu: GpuSnapshot;
  /** System memory free right now: what a send judges by. */
  memAvailableBytes: number;
  /** The system memory this computer has: what every list judges a model against. */
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

/** /api/show for `model`, asked once per reading. A failed answer is not kept. */
export function showOf(deps: FitDeps, r: Readings, model: string): Promise<ShowResponse> {
  const key = r.tags.models.find((m) => sameModel(m.name, model))?.name ?? model;
  let show = r.shows.get(key);
  if (show === undefined) {
    show = untilAborted(fetchShow(deps.baseUrl, model, deps.signal), deps.signal);
    r.shows.set(key, show);
    show.catch(() => r.shows.delete(key));
  }
  return show;
}

export async function fitWithReadings(deps: FitDeps, model: string, requested: number, r: Readings): Promise<FitCheck> {
  const loaded = findLoaded(r.ps, model);
  const tag = r.tags.models.find((m) => sameModel(m.name, model));
  // Measured only when /api/ps proves the resident copy runs at this num_ctx (an Ollama that leaves
  // context_length out may hold it at a smaller one, so that copy is estimated like a cold one),
  // and only when the measurement is on the estimate's basis (measuredNeed). A copy /api/tags does
  // not list has no known weights; /api/ps saying nothing spilled is then the only proof.
  const measured = (numCtx: number, weights = tag?.size ?? 0): FitCheck | undefined => {
    if (!loaded || loaded.context_length !== numCtx) return undefined;
    const need = measuredNeed(loaded, runnerBytesOf(r.gpu, r.ps.models.length), weights);
    if (need === undefined) return undefined;
    return { report: { ...measuredReport(model, loaded, numCtx, r.gpu, r.ps.models.length), needVramBytes: need }, resident: true, gpu: r.gpu, memAvailableBytes: r.memAvailableBytes };
  };
  const now = measured(requested);
  if (now) return now;
  if (!tag) throw new FitError("model-not-found", `${model} is not in /api/tags`);

  const show = await showOf(deps, r, model);
  // The one place the size a model runs at is decided; the report carries it to every caller.
  const numCtx = effectiveNumCtx(requested, reportedContextLength(show.model_info));
  // On a card, the weights are the file less what the runtime keeps in system memory (off-card.ts).
  // With no card everything is in system memory, so the whole file counts.
  const offCard = r.gpu.gpuCount > 0 && hasPerLayerTable(show.model_info) ? await untilAborted(offCardBytes(deps.baseUrl, model, tag.digest ?? tag.name, deps.signal), deps.signal) : undefined;
  const weights = Math.max(0, tag.size - (offCard ?? 0));
  const atMax = numCtx === requested && offCard === undefined ? undefined : measured(numCtx, weights);
  if (atMax) return atMax;
  const estimate = needAt(model, numCtx, weights, show.model_info, deps.estimate);
  // One basis per model: a copy wholly on the GPU moves every context by its measurement's offset.
  const runnerBytes = runnerBytesOf(r.gpu, r.ps.models.length);
  const loadedCtx = loaded?.context_length;
  const held = loaded ? Math.max(loaded.size_vram, runnerBytes ?? 0) : 0;
  const atLoaded = loaded && loadedCtx !== undefined ? needAt(model, loadedCtx, weights, show.model_info, deps.estimate).need : undefined;
  const measuredLoaded = loaded && atLoaded ? measuredNeed(loaded, runnerBytes, weights) : undefined;
  const offset = measuredLoaded === undefined || atLoaded === undefined ? 0 : measuredLoaded - atLoaded.totalBytes;
  const need = offsetNeed(estimate.need, offset);

  // Loaded at this num_ctx but partly in system memory: it runs as it is, so it is never refused.
  // Its need stays the estimate's total; what it holds on the GPU is what it does not spill.
  if (loaded && loaded.context_length === numCtx) {
    const spill = Math.max(0, need - held);
    return {
      report: worded({
        model, numCtx, freeVramBytes: r.gpu.freeBytes + held, needVramBytes: need, spillRamBytes: spill,
        verdict: spill > 0 ? "spills" : "fits", source: "estimate", measuredAt: r.gpu.measuredAt,
        message: `${model} is loaded at num_ctx ${numCtx} with ${formatGb(held)} on the GPU and the rest in system memory; it needs ${formatGb(need)} in all (estimate).`,
      }, "now", r.gpu),
      resident: true, gpu: r.gpu, memAvailableBytes: r.memAvailableBytes, estimate: estimate.need,
    };
  }

  // A copy loaded at another num_ctx is replaced by Ollama on the next
  // request, so the VRAM it holds counts as free for this plan. At an unknown
  // context it is either replaced or reused as is; either way the question is
  // whether the model at this num_ctx fits in what it holds plus what is free.
  const reclaim = loaded ? loaded.size_vram : 0;
  // Its system-memory part frees with it: what /api/ps counts outside the GPU. At a context no larger
  // than the loaded one, also what its own row says it holds there, so a smaller context is never
  // refused while the loaded one runs. Above it, no more: weights mapped from disk are page cache.
  const smaller = loadedCtx !== undefined && numCtx <= loadedCtx && atLoaded !== undefined;
  const ramReclaim = loaded ? Math.max(loaded.size - loaded.size_vram, smaller ? offsetNeed(atLoaded, offset) - held : 0, 0) : 0;
  // judge() never counts system memory below what this computer has (docs/evidence/windows-low-memory-bug-report.md).
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
  });
  // A refusal carries the system memory of the reading it was decided from, beside its free VRAM.
  const reading = report.verdict === "refuse" ? { memAvailableBytes: r.memAvailableBytes } : {};
  return { report: { ...report, needVramBytes: need, ...reading }, gpu: r.gpu, memAvailableBytes: r.memAvailableBytes, estimate: estimate.need };
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
   * The fit with no busy turn stopped. Before a handoff (the fit table, a question about a send),
   * every other resident model's VRAM counts as reclaimable, since the handoff asks those to leave;
   * after it (`measured`), only what the reading shows free.
   */
  report: TotalReport;
  /** The busy models whose turns must stop for the load (only chat.send stopOthers stops them). */
  stop: string[];
}

/**
 * The one fit planner for a load of `model` at `numCtx`: the fit table's rows, preloads and
 * chat.send. From one reading. Resident models not in `busy` (no running reply uses them) are what
 * a handoff (gpu/memory.ts) asks to leave: a plan before the handoff counts their memory, a plan
 * after it (`measured`) counts only what the reading shows free, so a model that was asked and
 * stayed is measured as it is. Busy models come next, the fewest and largest first: they are
 * reclaimable only by stopping their turns, which only chat.send's stopOthers does, so `report`
 * never counts them. The image engine's memory is never counted: the handoff frees it, or it stays.
 *
 * `stop` is empty when the model is resident at this num_ctx, fits without any busy model, or
 * refuses even with every busy one gone (stopping them would not help); otherwise the busy ones
 * whose VRAM makes it fit. In an Ollama that holds one model no model fits beside a busy one: `stop`
 * is every busy model unless this one is resident or refuses even with them gone. The same model in
 * `busy` never counts. Reads only; never loads or stops anything.
 */
export async function planLoad(deps: FitDeps & { model: string; numCtx: number; busy: readonly string[]; measured?: boolean }): Promise<LoadPlan> {
  return planWith(deps, await takeReadings(deps));
}

/** planLoad from a reading already taken: the fit table plans every row from one. */
export async function planWith(deps: FitDeps & { model: string; numCtx: number; busy: readonly string[]; measured?: boolean }, r: Readings): Promise<LoadPlan> {
  const others = r.ps.models.filter((m) => !isCopyOf(m, deps.model));
  const busy = deps.busy.filter((b) => !sameModel(b, deps.model));
  const isBusy = (name: string) => busy.some((b) => sameModel(b, name));
  const candidates = others
    .filter((m) => isBusy(m.name))
    .toSorted((a, b) => b.size_vram - a.size_vram)
    .map((m) => m.name);
  // An Ollama that holds one model (RuntimeStatus.holdsOne) never runs this model beside another:
  // it unloads the idle ones itself at this load, and waits for a busy one's reply to end, so every
  // busy one is in the way whatever is free, on a card or not.
  const one = deps.holdsOne ?? holdsOneAt(deps.baseUrl);
  if (r.gpu.gpuCount === 0) {
    // With no GPU there is no VRAM to reclaim from another reply.
    const check = await fitWithReadings(deps, deps.model, deps.numCtx, r);
    const inTheWay = one && check.resident !== true && check.report.verdict !== "refuse";
    return { report: check.report, stop: inTheWay ? candidates : [] };
  }
  // The handoff asked nothing to leave from an Ollama that holds one model, so even after it
  // (`measured`) what the idle ones hold counts as leaving.
  const leaving = deps.measured === true && !one ? [] : others.filter((m) => !isBusy(m.name)).map((m) => m.name);
  const plan = async (stop: readonly string[]) => (await fitWithReadings({ ...deps, reclaim: [...leaving, ...stop] }, deps.model, deps.numCtx, r)).report;
  const first = await fitWithReadings({ ...deps, reclaim: leaving }, deps.model, deps.numCtx, r);
  const report = first.report;
  if (first.resident === true || candidates.length === 0) return { report, stop: [] };
  if (one) return { report, stop: (await plan(candidates)).verdict === "refuse" ? [] : candidates };
  if (report.verdict === "fits") return { report, stop: [] };
  for (let n = 1; n <= candidates.length; n++) {
    if ((await plan(candidates.slice(0, n))).verdict === "fits") return { report, stop: candidates.slice(0, n) };
  }
  // Every busy turn stopped and it only spills: stop them all; refused even then: stop none.
  const last = candidates.length === 0 ? report : await plan(candidates);
  if (last.verdict === "refuse") return { report, stop: [] };
  return { report, stop: candidates };
}

/** planLoad's `stop`: the busy models a load would push out. */
export const blockingModels = async (deps: FitDeps & { model: string; numCtx: number; busy: readonly string[] }): Promise<string[]> => (await planLoad(deps)).stop;

/**
 * After a real load: what /api/ps and nvidia-smi say the copy holds (the real-machine check). Its
 * need is the measured report's, not a TotalNeed: the fit table never shows it.
 */
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
  memTotalBytes: number;
  /** One report per model whose check ran; a model whose check failed (no /api/show geometry, say) is absent. */
  reports: Map<string, FitReport>;
}

/**
 * The system memory a model is judged against: what the computer has, less the system's own share
 * (SYSTEM_RAM_RESERVE_BYTES). decideFit then keeps its usual RAM margin back from it as well.
 */
export const cardRamBytes = (memTotalBytes: number): number => Math.max(0, memTotalBytes - SYSTEM_RAM_RESERVE_BYTES);

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
  return { gpu: readings.gpu, memAvailableBytes: readings.memAvailableBytes, memTotalBytes: readings.memTotalBytes, reports };
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
  /** The reading it is judged on, against the card (judge "card"). */
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

/** A not-downloaded model's total need: the download as weights, a rough KV cache, the overhead. */
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
