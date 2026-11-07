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
import type { ModelInfo } from "./types.ts";

export interface CatalogDeps {
  readonly baseUrl: () => string | undefined;
  /** The installed list (the model catalog's current or refreshed list). */
  readonly installed: () => Promise<readonly ModelInfo[]>;
  readonly settings: Pick<SettingsReader, "get">;
  readonly fit?: Omit<FitDeps, "baseUrl">;
  readonly log?: (line: string) => void;
}

/** Embedding models never chat, so they stay out of the catalog. */
const isEmbedding = (m: ModelInfo) => /embed/i.test(m.name) || /bert/i.test(m.family ?? "");

const withFit = (entry: Omit<CatalogEntry, "fit" | "recommended">, fit: FitReport | undefined): CatalogEntry => ({
  ...entry,
  recommended: false,
  ...(fit === undefined ? {} : { fit }),
});

export async function buildCatalog(deps: CatalogDeps): Promise<CatalogEntry[]> {
  const numCtx = deps.settings.get().defaultNumCtx;
  const baseUrl = deps.baseUrl();
  const installed = baseUrl === undefined ? [] : (await deps.installed()).filter((m) => !isEmbedding(m));

  let survey: FitSurvey | undefined;
  if (baseUrl !== undefined) {
    try {
      survey = await surveyFit({ ...deps.fit, baseUrl, numCtx, models: installed.map((m) => m.name) });
    } catch (e) {
      deps.log?.(`catalog fit survey failed: ${(e as Error).message}`);
    }
  }

  const entries: CatalogEntry[] = [];
  const byTag = new Map(installed.map((m) => [canonicalTag(m.name), m]));
  for (const c of CURATED_MODELS) {
    const own = byTag.get(c.name);
    if (own) {
      entries.push(withFit({ name: own.name, label: c.label, purpose: c.purpose, downloadBytes: own.sizeBytes, installed: true }, survey?.reports.get(own.name)));
    } else if (c.pullable) {
      const fit = survey
        ? estimateBeforeDownload({
            model: c.name,
            numCtx,
            downloadBytes: c.downloadBytes,
            freeVramBytes: survey.gpu.freeBytes,
            memAvailableBytes: survey.memAvailableBytes,
            measuredAt: survey.gpu.measuredAt,
            ...(deps.fit?.margins ? { margins: deps.fit.margins } : {}),
          })
        : undefined;
      entries.push(withFit({ name: c.name, label: c.label, purpose: c.purpose, downloadBytes: c.downloadBytes, installed: false }, fit));
    }
  }
  for (const m of installed) {
    if (curated(m.name)) continue;
    entries.push(withFit({ name: m.name, label: modelLabel(m.name), purpose: OWN_MODEL_PURPOSE, downloadBytes: m.sizeBytes, installed: true }, survey?.reports.get(m.name)));
  }

  return markRecommended(entries);
}

/** "fits" models are recommended; when none fits, the lightest one that spills. */
export function markRecommended(entries: readonly CatalogEntry[]): CatalogEntry[] {
  const fits = entries.filter((e) => e.fit?.verdict === "fits");
  if (fits.length > 0) return entries.map((e) => ({ ...e, recommended: e.fit?.verdict === "fits" }));
  const lightest = entries
    .filter((e) => e.fit?.verdict === "spills")
    .toSorted((a, b) => (a.fit?.needVramBytes ?? 0) - (b.fit?.needVramBytes ?? 0))[0];
  return entries.map((e) => ({ ...e, recommended: e === lightest }));
}
