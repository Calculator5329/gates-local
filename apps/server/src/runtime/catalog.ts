// models.catalog: the curated models merged with what is installed. Installed
// models get a verdict from the fit check at the default context; curated
// models not downloaded yet get the rough pre-download estimate (source
// "estimate", and the message says so). Recommended is the computer's tier
// (tiers.ts): picks by the GPU's memory, or by system memory with no GPU.
import type { CatalogEntry, FitReport, ModelEstimate } from "@gates-local/contracts";
import { cardRamBytes, decideFit, estimateBeforeDownload, surveyFit, type FitDeps, type FitSurvey } from "../fit/fit.ts";
import { defaultMeminfo, defaultNvidiaSmi, GPU_REUSE_MS, readGpu, readMemory } from "../fit/gpu.ts";
import type { RegistryLookup } from "./registry-size.ts";
import type { SettingsReader } from "../settings/store.ts";
import { canonicalTag, CURATED_MODELS, curated, modelLabel, OWN_MODEL_PURPOSE } from "./recommended.ts";
import { canChat } from "./pick.ts";
import { tierFor, type Tier } from "./tiers.ts";
import type { ModelInfo } from "./types.ts";

export interface CatalogDeps {
  readonly baseUrl: () => string | undefined;
  /** The installed list (the model catalog's current or refreshed list). */
  readonly installed: () => Promise<readonly ModelInfo[]>;
  readonly settings: Pick<SettingsReader, "get">;
  readonly fit?: Omit<FitDeps, "baseUrl">;
  readonly log?: (line: string) => void;
}


const withFit = (entry: Omit<CatalogEntry, "fit" | "recommended">, fit: FitReport | undefined): CatalogEntry => ({
  ...entry,
  recommended: false,
  ...(fit === undefined ? {} : { fit }),
});

/** A download is judged against the card and the system memory the computer has, as the fit table's rows are. */
const preDownload = (c: Pick<CatalogEntry, "name" | "downloadBytes">, numCtx: number, survey: FitSurvey, fit: CatalogDeps["fit"]): FitReport =>
  estimateBeforeDownload({
    model: c.name,
    numCtx,
    downloadBytes: c.downloadBytes,
    freeVramBytes: fit?.baseline?.cardFree(survey.gpu) ?? survey.gpu.freeBytes,
    memAvailableBytes: cardRamBytes(survey.memTotalBytes),
    measuredAt: survey.gpu.measuredAt,
    ...(fit?.margins ? { margins: fit.margins } : {}),
  });

/** An installed model's right-now report judged against the card instead, as the fit table's `card` verdict is. */
const onCard = (r: FitReport, survey: FitSurvey, fit: CatalogDeps["fit"]): FitReport =>
  decideFit({
    model: r.model,
    numCtx: r.numCtx,
    needBytes: r.needVramBytes,
    freeVramBytes: Math.max(fit?.baseline?.cardFree(survey.gpu) ?? survey.gpu.freeBytes, r.freeVramBytes),
    memAvailableBytes: cardRamBytes(survey.memTotalBytes),
    measuredAt: r.measuredAt,
    ...(fit?.margins ? { margins: fit.margins } : {}),
  });

/** A model the catalog lists, before its fit: the installed chat models, then the ones offered for download. */
export type CatalogModel = Omit<CatalogEntry, "fit" | "recommended">;

/** The models the catalog lists, from the installed list: the fit table states the same ones. */
export function catalogModels(listed: readonly ModelInfo[]): CatalogModel[] {
  const installed = listed.filter(canChat); // embedding models never chat; unknown ones wait for discovery
  // Every installed name, chat or not: an installed model is never offered as a download (MP-01).
  const installedTags = new Set(listed.map((m) => canonicalTag(m.name)));
  const models: CatalogModel[] = [];
  const byTag = new Map(installed.map((m) => [canonicalTag(m.name), m]));
  for (const c of CURATED_MODELS) {
    const own = byTag.get(c.name);
    if (own) models.push({ name: own.name, label: c.label, purpose: c.purpose, downloadBytes: own.sizeBytes, installed: true });
    else if (c.pullable && !installedTags.has(c.name)) models.push({ name: c.name, label: c.label, purpose: c.purpose, downloadBytes: c.downloadBytes, installed: false });
  }
  for (const m of installed) {
    if (!curated(m.name)) models.push({ name: m.name, label: modelLabel(m.name), purpose: OWN_MODEL_PURPOSE, downloadBytes: m.sizeBytes, installed: true });
  }
  return models;
}

export async function buildCatalog(deps: CatalogDeps): Promise<CatalogEntry[]> {
  const numCtx = deps.settings.get().defaultNumCtx;
  const baseUrl = deps.baseUrl();
  const models = catalogModels(baseUrl === undefined ? [] : await deps.installed());

  let survey: FitSurvey | undefined;
  if (baseUrl !== undefined) {
    try {
      survey = await surveyFit({ ...deps.fit, baseUrl, numCtx, models: models.filter((m) => m.installed).map((m) => m.name) });
    } catch (e) {
      deps.log?.(`catalog fit survey failed: ${(e as Error).message}`);
    }
  }
  if (survey) deps.fit?.baseline?.observe(survey.gpu);

  const entries = models.map((m) => withFit(m, m.installed ? survey?.reports.get(m.name) : survey && preDownload(m, numCtx, survey, deps.fit)));
  if (survey === undefined) return entries;
  const tier = tierFor({ gpuCount: survey.gpu.gpuCount, gpuTotalBytes: survey.gpu.totalBytes, systemTotalBytes: survey.memTotalBytes });
  // An installed model's report plans it right now, as a send would load it; whether it is
  // recommended is judged against the card, as the lists show it (the owner's ruling, 2026-11-13).
  const s = survey;
  const judged = entries.map((e) => (e.installed && e.fit !== undefined ? { ...e, fit: onCard(e.fit, s, deps.fit) } : e));
  return markRecommended(judged, numCtx, tier).map((e, i) => {
    const own = entries[i]?.fit;
    return own === undefined ? e : { ...e, fit: own };
  });
}

export interface EstimateDeps {
  /** The registry's answer for a name; absent when the registry is off (tests, a pinned Ollama). */
  readonly lookup?: (name: string, signal: AbortSignal) => Promise<RegistryLookup>;
  readonly fit?: Omit<FitDeps, "baseUrl">;
}

/**
 * A typed name before its download: its size (the curated list, else the registry) and its fit
 * against the card and the system memory the computer has, as the Download list's rows are judged.
 * A name whose size cannot be read gets no fit: the size is what the estimate is made from.
 */
export async function estimateTyped(deps: EstimateDeps, name: string, numCtx: number, signal: AbortSignal): Promise<ModelEstimate> {
  const tag = canonicalTag(name.trim());
  const known = curated(tag)?.downloadBytes;
  const found: RegistryLookup = known !== undefined ? { kind: "size", bytes: known } : deps.lookup ? await deps.lookup(tag, signal) : { kind: "unreadable" };
  if (found.kind !== "size") return { name: tag, found: found.kind === "missing" ? "no" : "unknown" };
  const fit = deps.fit;
  try {
    const [gpu, memory] = await Promise.all([
      readGpu(fit?.runNvidiaSmi ?? defaultNvidiaSmi, fit?.now ?? Date.now, signal, GPU_REUSE_MS),
      readMemory(fit?.readMeminfo ?? defaultMeminfo, signal),
    ]);
    const report = estimateBeforeDownload({
      model: tag,
      numCtx,
      downloadBytes: found.bytes,
      freeVramBytes: fit?.baseline?.cardFree(gpu) ?? Math.max(gpu.freeBytes, gpu.totalBytes),
      memAvailableBytes: cardRamBytes(memory.totalBytes),
      measuredAt: gpu.measuredAt,
      ...(fit?.margins ? { margins: fit.margins } : {}),
    });
    return { name: tag, found: "yes", downloadBytes: found.bytes, fit: report };
  } catch {
    // no reading of the GPU or memory: the size alone
    return { name: tag, found: "yes", downloadBytes: found.bytes };
  }
}

/**
 * The tier's picks are recommended, in its order (`rank`), each one that can run here: a pick
 * with no verdict, one that cannot hold the default context, or one with not enough memory is
 * left with the rest.
 */
export function markRecommended(entries: readonly CatalogEntry[], numCtx: number, tier: Tier): CatalogEntry[] {
  return entries.map((e) => {
    const rank = tier.picks.indexOf(canonicalTag(e.name));
    const runs = e.fit !== undefined && e.fit.numCtx >= numCtx && e.fit.verdict !== "refuse";
    return rank >= 0 && runs ? { ...e, recommended: true, rank } : { ...e, recommended: false };
  });
}
