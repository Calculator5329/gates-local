export const MIB = 1024 * 1024;
export const GIB = 1024 * MIB;

// external: Ollama runs a model at 4096 tokens unless told otherwise, the one size every model it serves takes.
export const UNREPORTED_MAX_CONTEXT = 4096;

export const KV_REFERENCE_CONTEXT = 16 * 1024;

// why: kept free beyond the estimate for allocator slack and the desktop's growth.
export const VRAM_SAFETY_MARGIN_BYTES = 512 * MIB;

export const RAM_SAFETY_MARGIN_BYTES = 2 * GIB;

// why: a round figure for the OS, this app and a browser, not a measurement.
export const SYSTEM_RAM_RESERVE_BYTES = 1 * GIB;

// why: CUDA context, compute graph scratch and runner buffers beyond weights and KV.
export const RUNTIME_OVERHEAD_BYTES = 1 * GIB;

// external: Ollama keeps the KV cache as f16, two bytes an element, unless OLLAMA_KV_CACHE_TYPE says otherwise.
export const KV_BYTES_PER_ELEMENT = 2;

// why: a rule of thumb until an installed model reports its geometry, not a measurement.
export const PREDOWNLOAD_KV_FRACTION_PER_16K = 0.1;

// external: a sliding-window layer in Ollama keeps one batch of 512 tokens beyond its window.
export const SWA_BATCH_TOKENS = 512;
