import type { CatalogEntry, FitReport, ModelEstimate } from "@gates-local/contracts";
import { estimateBeforeDownload, judge, surveyFit, type FitDeps, type FitSurvey } from "../fit/fit.ts";
import { defaultMeminfo, defaultNvidiaSmi, GPU_REUSE_MS, readGpu, readMemory } from "../fit/gpu.ts";
import type { RegistryLookup } from "./registry-size.ts";
import type { SettingsReader } from "../settings/store.ts";
import { canonicalTag, curated, curatedModels, modelLabel, OWN_MODEL_PURPOSE } from "./recommended.ts";
import { canChat } from "./pick.ts";
import { tierFor, type Tier } from "./tiers.ts";
import type { ModelInfo } from "./types.ts";

export interface CatalogDeps {
  readonly baseUrl: () => string | undefined;
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
  estimateBeforeDownload({ model: c.name, numCtx, downloadBytes: c.downloadBytes, gpu: survey.gpu, memTotalBytes: survey.memTotalBytes, ...(fit?.margins ? { margins: fit.margins } : {}) });

const onCard = (r: FitReport, survey: FitSurvey, fit: CatalogDeps["fit"]): FitReport =>
  judge("card", { model: r.model, numCtx: r.numCtx, needBytes: r.needVramBytes, gpu: survey.gpu, memTotalBytes: survey.memTotalBytes, freeVramBytes: r.freeVramBytes, ...(fit?.margins ? { margins: fit.margins } : {}) });

export type CatalogModel = Omit<CatalogEntry, "fit" | "recommended">;

export function catalogModels(listed: readonly ModelInfo[]): CatalogModel[] {
  const installed = listed.filter(canChat);
  const installedTags = new Set(listed.map((m) => canonicalTag(m.name)));
  const models: CatalogModel[] = [];
  const byTag = new Map(installed.map((m) => [canonicalTag(m.name), m]));
  for (const c of curatedModels()) {
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
  const s = survey;
  const judged = entries.map((e) => (e.installed && e.fit !== undefined ? { ...e, fit: onCard(e.fit, s, deps.fit) } : e));
  return markRecommended(judged, numCtx, tier).map((e, i) => {
    const own = entries[i]?.fit;
    return own === undefined ? e : { ...e, fit: own };
  });
}

export interface EstimateDeps {
  readonly lookup?: (name: string, signal: AbortSignal) => Promise<RegistryLookup>;
  readonly fit?: Omit<FitDeps, "baseUrl">;
}

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
    const report = estimateBeforeDownload({ model: tag, numCtx, downloadBytes: found.bytes, gpu, memTotalBytes: memory.totalBytes, ...(fit?.margins ? { margins: fit.margins } : {}) });
    return { name: tag, found: "yes", downloadBytes: found.bytes, fit: report };
  } catch {
    return { name: tag, found: "yes", downloadBytes: found.bytes };
  }
}

export function markRecommended(entries: readonly CatalogEntry[], numCtx: number, tier: Tier): CatalogEntry[] {
  return entries.map((e) => {
    const rank = tier.picks.indexOf(canonicalTag(e.name));
    const runs = e.fit !== undefined && e.fit.numCtx >= numCtx && e.fit.verdict !== "refuse";
    return rank >= 0 && runs ? { ...e, recommended: true, rank } : { ...e, recommended: false };
  });
}
