// Ollama runtime: discovery, the app-owned install and server, process
// ownership and the model list.
export type { InstallPhase, InstallProgress, LoadedModel, ModelInfo, RuntimeOwner, RuntimeState, RuntimeStatus } from "./types.ts";
export { createOllamaRuntime, DEFAULT_APP_PORT, DEFAULT_EXTERNAL_BASE_URL, type OllamaRuntime, type RuntimeOptions } from "./runtime.ts";
export { createModelCatalog, listLoaded, listModels, RuntimeResponseError, type ModelCatalog } from "./models.ts";
export { InstallError, installPinned, type InstallErrorCode, type InstallResult } from "./install.ts";
export { PINNED_OLLAMA } from "./manifest.ts";
export { defaultAppDataDir, detectModelsDir, findModelsDirs, SYSTEM_MODELS_DIRS, type ModelsDir } from "./paths.ts";
export { probe, type ProbeResult } from "./probe.ts";
export type { StopResult } from "./ownership.ts";
