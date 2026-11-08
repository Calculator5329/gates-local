// Fit check: measured free VRAM against a model's need at a num_ctx.
export * from "./constants.ts";
export * from "./types.ts";
export { formatBytes, formatGb } from "./format.ts";
export {
  defaultMeminfo,
  defaultNvidiaSmi,
  parseComputeApps,
  parseGpuTotals,
  parseMemAvailable,
  readGpu,
  readMemAvailable,
} from "./gpu.ts";
export { effectiveNumCtx, estimateKvCache, estimateNeed, parseArchInfo, reportedContextLength, type ArchInfo } from "./estimate.ts";
export { fetchPs, fetchShow, fetchTags, findLoaded, sameModel, type PsEntry } from "./ollama.ts";
export {
  checkFit,
  checkModels,
  decideFit,
  DEFAULT_MARGINS,
  measuredFit,
  measuredReport,
  noModelFits,
  type FitCheck,
  type FitDeps,
  type Margins,
  type ModelsFit,
} from "./fit.ts";
