// models.catalog: the curated models merged with what is installed. Installed
// models get a verdict from the fit check at the default context; curated
// models not downloaded yet get the rough pre-download estimate (source
// "estimate", and the message says so). Recommended means "runs on the GPU";
// on a machine with no GPU, where nothing does, it is the lightest model that
// runs in system memory.
import type { CatalogEntry, FitReport } from "@gates-local/contracts";
import { estimateBeforeDownload, surveyFit, type FitDeps, type FitSurvey } from "../fit/fit.ts";
import type { SettingsReader } from "../settings/store.ts";
import { canonicalTag, CURATED_MODELS, curated, modelLabel, OWN_MODEL_PURPOSE } from "./recommended.ts";
import { canChat } from "./pick.ts";
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

const preDownload = (c: Pick<CatalogEntry, "name" | "downloadBytes">, numCtx: number, survey: FitSurvey, fit: CatalogDeps["fit"]): FitReport =>
  estimateBeforeDownload({
    model: c.name,
    numCtx,
    downloadBytes: c.downloadBytes,
    freeVramBytes: survey.gpu.freeBytes,
    memAvailableBytes: survey.memAvailableBytes,
    measuredAt: survey.gpu.measuredAt,
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

  const entries = models.map((m) => withFit(m, m.installed ? survey?.reports.get(m.name) : survey && preDownload(m, numCtx, survey, deps.fit)));
  return markRecommended(entries, numCtx);
}

/**
 * "fits" models are recommended; when none fits, the lightest one that spills. A model that
 * cannot hold the default context is usable but no recommendation, so it never displaces one.
 */
export function markRecommended(entries: readonly CatalogEntry[], numCtx: number): CatalogEntry[] {
  const offered = entries.filter((e) => e.fit !== undefined && e.fit.numCtx >= numCtx);
  const fits = offered.filter((e) => e.fit?.verdict === "fits");
  if (fits.length > 0) return entries.map((e) => ({ ...e, recommended: fits.includes(e) }));
  const lightest = offered
    .filter((e) => e.fit?.verdict === "spills")
    .toSorted((a, b) => (a.fit?.needVramBytes ?? 0) - (b.fit?.needVramBytes ?? 0))[0];
  return entries.map((e) => ({ ...e, recommended: e === lightest }));
}
