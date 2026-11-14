// What a memory refusal offers instead (WIN-MEM-02): the largest smaller context of the refused
// model that runs, else the largest installed chat model that runs at the default context, and what
// the refused load lacks, the GPU and system memory apart. Every candidate is planned on the reading
// that refused (planWith, as the fit table's rows are), so the offer and the refusal agree.
import type { FitOffer } from "@gates-local/contracts";
import { DEFAULT_MARGINS, planWith, takeReadings, type FitDeps, type Margins, type Readings } from "./fit.ts";
import { GPU_REUSE_MS } from "./gpu.ts";
import { sameModel } from "./ollama.ts";
import { TABLE_CONTEXTS } from "./table.ts";
import type { FitReport } from "./types.ts";

const runs = (r: FitReport): r is FitReport & { verdict: "fits" | "spills" } => r.verdict !== "refuse";

/**
 * Pure: the offer from reports already planned on one reading. `contexts`: the refused model at
 * other sizes (a size not below the refused one is never offered). `models`: other installed chat
 * models at the default context. The model is offered only when no context runs; the largest
 * (by what it needs) of those that run.
 */
export function chooseOffer(input: { refused: FitReport; contexts: readonly FitReport[]; models: readonly FitReport[]; margins?: Margins }): FitOffer {
  const { refused } = input;
  const margins = input.margins ?? DEFAULT_MARGINS;
  const context = input.contexts.filter((r) => r.numCtx < refused.numCtx && runs(r)).toSorted((a, b) => b.numCtx - a.numCtx)[0];
  const model = context === undefined
    ? input.models.filter((r) => !sameModel(r.model, refused.model) && runs(r)).toSorted((a, b) => b.needVramBytes - a.needVramBytes)[0]
    : undefined;
  // decideFit's own sums, read back: usable GPU memory is free less its margin, and the shortfall is
  // what neither it nor the usable system memory covers.
  const gpuBytes = Math.max(0, refused.freeVramBytes - margins.vramMarginBytes);
  const shortBytes = refused.shortfallBytes ?? Math.max(0, refused.needVramBytes - gpuBytes);
  const ramBytes = Math.max(0, refused.needVramBytes - gpuBytes - shortBytes);
  return {
    ...(context && runs(context) ? { context: { numCtx: context.numCtx, verdict: context.verdict } } : {}),
    ...(model && runs(model) ? { model: { model: model.model, numCtx: model.numCtx, verdict: model.verdict } } : {}),
    short: { needBytes: refused.needVramBytes, gpuBytes, ramBytes, shortBytes },
  };
}

export interface OfferDeps extends FitDeps {
  /** Installed chat models (the catalog's), the refused one among them or not. */
  readonly models: readonly string[];
  /** The context a model offered instead is planned at: the app's default. */
  readonly defaultNumCtx: number;
  /** Models of admitted turns, as the refusing plan had them. */
  readonly busy: readonly string[];
  readonly comfyPid?: number;
}

/** chooseOffer from one reading: each candidate planned as a send would load it. A candidate whose check fails is left out. */
export async function offerFrom(deps: OfferDeps, r: Readings, refused: FitReport): Promise<FitOffer> {
  const plan = async (model: string, numCtx: number): Promise<FitReport | undefined> => {
    try {
      return (await planWith({ ...deps, model, numCtx, busy: deps.busy, ...(deps.comfyPid === undefined ? {} : { comfyPid: deps.comfyPid }) }, r)).report;
    } catch {
      return undefined;
    }
  };
  const contexts: FitReport[] = [];
  for (const numCtx of TABLE_CONTEXTS.filter((c) => c < refused.numCtx).toReversed()) {
    const report = await plan(refused.model, numCtx);
    if (report === undefined) continue;
    contexts.push(report);
    // the largest that runs is the offer; smaller ones change nothing
    if (report.verdict !== "refuse") break;
  }
  const models: FitReport[] = [];
  if (!contexts.some(runs)) {
    for (const name of deps.models.filter((m) => !sameModel(m, refused.model))) {
      const report = await plan(name, deps.defaultNumCtx);
      // the context offered is the default asked for; the model runs at its own cap when that is less
      if (report !== undefined) models.push({ ...report, numCtx: deps.defaultNumCtx });
    }
  }
  return chooseOffer({ refused, contexts, models, ...(deps.margins ? { margins: deps.margins } : {}) });
}

/**
 * The offer for a refusal just made: the GPU reading the refusing plan took (a reading at most
 * GPU_REUSE_MS old is shared), with the runtime and system memory read again. Undefined when a
 * reading fails: the refusal goes out without one.
 */
export async function offerAfterRefusal(deps: OfferDeps, refused: FitReport): Promise<FitOffer | undefined> {
  if (refused.verdict !== "refuse") return undefined;
  try {
    return await offerFrom(deps, await takeReadings({ ...deps, reuseGpuMs: GPU_REUSE_MS }), refused);
  } catch {
    return undefined;
  }
}
