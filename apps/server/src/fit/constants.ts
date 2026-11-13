// The numbers the fit check states. Every margin here is shown in the
// report message so a verdict can be checked by hand.

export const MIB = 1024 * 1024;
export const GIB = 1024 * MIB;

/**
 * The context a model runs at when /api/show reports no maximum: Ollama's own
 * default, the one size any model it serves is known to take.
 */
export const UNREPORTED_MAX_CONTEXT = 4096;

/** The context PREDOWNLOAD_KV_FRACTION_PER_16K is stated for. */
export const KV_REFERENCE_CONTEXT = 16384;

/** VRAM kept free beyond the estimate: allocator slack and the desktop's growth. */
export const VRAM_SAFETY_MARGIN_BYTES = 512 * MIB;

/** RAM kept back from MemAvailable before any spill is allowed. */
export const RAM_SAFETY_MARGIN_BYTES = 2 * GIB;

/**
 * The system's own share of the memory a computer has (the OS, this app, a browser), held back
 * when a model is judged against MemTotal rather than what is free right now (the owner's ruling,
 * 2026-11-13). With RAM_SAFETY_MARGIN_BYTES that is 3 GiB in all, which leaves an 8 GB laptop
 * room for the smallest curated model. A round figure, not a measurement.
 */
export const SYSTEM_RAM_RESERVE_BYTES = 1 * GIB;

/** CUDA context, compute graph scratch and runner buffers beyond weights and KV. */
export const RUNTIME_OVERHEAD_BYTES = 1 * GIB;

/** f16 KV cache (Ollama's default OLLAMA_KV_CACHE_TYPE). */
export const KV_BYTES_PER_ELEMENT = 2;

/**
 * Before a download there is no architecture to size the KV cache from, so
 * the catalog takes it as this share of the download per 16k tokens. A rule
 * of thumb, not a measurement; the real estimate replaces it once the model
 * is installed and /api/show gives its geometry.
 */
export const PREDOWNLOAD_KV_FRACTION_PER_16K = 0.1;

/** Extra tokens a sliding-window layer keeps beyond its window (one batch). */
export const SWA_BATCH_TOKENS = 512;
