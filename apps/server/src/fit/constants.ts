// The numbers the fit check states. Every margin here is shown in the
// report message so a verdict can be checked by hand.

export const MIB = 1024 * 1024;
export const GIB = 1024 * MIB;

/** The context floor. Nothing runs below 16k. */
export const NUM_CTX_FLOOR = 16384;

/** VRAM kept free beyond the estimate: allocator slack and the desktop's growth. */
export const VRAM_SAFETY_MARGIN_BYTES = 512 * MIB;

/** RAM kept back from MemAvailable before any spill is allowed. */
export const RAM_SAFETY_MARGIN_BYTES = 2 * GIB;

/** CUDA context, compute graph scratch and runner buffers beyond weights and KV. */
export const RUNTIME_OVERHEAD_BYTES = 1 * GIB;

/** f16 KV cache (Ollama's default OLLAMA_KV_CACHE_TYPE). */
export const KV_BYTES_PER_ELEMENT = 2;

/** Extra tokens a sliding-window layer keeps beyond its window (one batch). */
export const SWA_BATCH_TOKENS = 512;
