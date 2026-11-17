import { FREE_AT_ONCE, type FitOffer, type OtherHolder } from "@gates-local/contracts";
import { cardMargins, DEFAULT_MARGINS, planWith, takeReadings, type FitDeps, type Margins, type Readings } from "./fit.ts";
import { GPU_REUSE_MS } from "./gpu.ts";
import { sameModel } from "./ollama.ts";
import { TABLE_CONTEXTS } from "./table.ts";
import type { FitReport } from "./types.ts";

const runs = (r: FitReport): r is FitReport & { verdict: "fits" | "spills" } => r.verdict !== "refuse";
const said = (r: FitReport) => (r.words === undefined ? {} : { words: r.words });

export function chooseOffer(input: { refused: FitReport; contexts: readonly FitReport[]; models: readonly FitReport[]; margins?: Margins }): FitOffer {
  const { refused } = input;
  const margins = input.margins ?? DEFAULT_MARGINS;
  const context = input.contexts.filter((r) => r.numCtx < refused.numCtx && runs(r)).toSorted((a, b) => b.numCtx - a.numCtx)[0];
  const model = context === undefined
    ? input.models.filter((r) => !sameModel(r.model, refused.model) && runs(r)).toSorted((a, b) => b.needVramBytes - a.needVramBytes)[0]
    : undefined;
  // why: decideFit's own sums read back, so the offer and the refusal state the same numbers.
  const gpuBytes = Math.max(0, refused.freeVramBytes - margins.vramMarginBytes);
  const shortBytes = refused.shortfallBytes ?? Math.max(0, refused.needVramBytes - gpuBytes);
  const ramBytes = Math.max(0, refused.needVramBytes - gpuBytes - shortBytes);
  return {
    ...(context && runs(context) ? { context: { numCtx: context.numCtx, verdict: context.verdict, ...said(context) } } : {}),
    ...(model && runs(model) ? { model: { model: model.model, numCtx: model.numCtx, verdict: model.verdict, ...said(model) } } : {}),
    short: { needBytes: refused.needVramBytes, gpuBytes, ramBytes, shortBytes },
  };
}

// why: a refusal with no smaller choice still carries "Free it", with the refusal's own sums
export function withFree(offer: FitOffer | undefined, refused: FitReport, held: readonly OtherHolder[] | undefined): FitOffer | undefined {
  if (held === undefined || held.length === 0 || refused.verdict !== "refuse") return offer;
  // why: one Free it is one memory.free, so the offer names no more than it takes, largest first
  const free = held.toSorted((a, b) => b.bytes - a.bytes).slice(0, FREE_AT_ONCE);
  return { ...offer ?? chooseOffer({ refused, contexts: [], models: [] }), free };
}

export interface OfferDeps extends FitDeps {
  readonly models: readonly string[];
  readonly defaultNumCtx: number;
  readonly busy: readonly string[];
  readonly comfyPid?: number;
}

export async function offerFrom(deps: OfferDeps, r: Readings, refused: FitReport): Promise<FitOffer> {
  const plan = async (model: string, numCtx: number): Promise<FitReport | undefined> => {
    try {
      return (await planWith({ ...deps, model, numCtx, busy: deps.busy, ...(deps.comfyPid === undefined ? {} : { comfyPid: deps.comfyPid }) }, r)).report;
    } catch {
      // why: a candidate whose check fails is left out of the offer.
      return undefined;
    }
  };
  const contexts: FitReport[] = [];
  for (const numCtx of TABLE_CONTEXTS.filter((c) => c < refused.numCtx).toReversed()) {
    const report = await plan(refused.model, numCtx);
    if (report === undefined) continue;
    contexts.push(report);
    // why: the largest that runs is the offer; smaller ones change nothing.
    if (report.verdict !== "refuse") break;
  }
  const models: FitReport[] = [];
  if (!contexts.some(runs)) {
    for (const name of deps.models.filter((m) => !sameModel(m, refused.model))) {
      const report = await plan(name, deps.defaultNumCtx);
      // why: the offer names the default asked for; the model runs at its own cap when that is less.
      if (report !== undefined) models.push({ ...report, numCtx: deps.defaultNumCtx });
    }
  }
  // why: the margins the refusal was judged with, one per card when there is more than one.
  return chooseOffer({ refused, contexts, models, margins: cardMargins(deps.margins ?? DEFAULT_MARGINS, r.gpu, "now").margins });
}

export async function offerAfterRefusal(deps: OfferDeps, refused: FitReport): Promise<FitOffer | undefined> {
  if (refused.verdict !== "refuse") return undefined;
  try {
    // why: reuseGpuMs shares the GPU reading the refusing plan just took.
    return await offerFrom(deps, await takeReadings({ ...deps, reuseGpuMs: GPU_REUSE_MS }), refused);
  } catch {
    // why: when a reading fails the refusal goes out without an offer.
    return undefined;
  }
}
