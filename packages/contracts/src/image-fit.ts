// The one image fit: the server's job fit (apps/server/src/image/module.ts) decides with it and
// the image picker shows its answer, so a size the picker marks as fitting is one the server runs.

export interface ImageFitInput {
  /** The preset's estimate at the job's size. */
  readonly estimateBytes: number;
  /** Free GPU memory now. */
  readonly freeBytes: number;
  /** ComfyUI's own resident memory: the job reuses it, so it counts as free for the job. */
  readonly creditedBytes: number;
  /** Memory the image may get back by unloading chat models (0 when it may unload none). */
  readonly freeableBytes?: number;
}

export interface ImageFitAnswer {
  /** `fits` now, `frees`: fits once the chat models it may unload are gone, `refuse`: does not fit. */
  readonly verdict: "fits" | "frees" | "refuse";
  /** What free memory lacks now (0 when it fits). */
  readonly shortBytes: number;
}

/** How an image job sits in GPU memory. No margin: the job runs when its estimate fits. */
export function imageFitVerdict(input: ImageFitInput): ImageFitAnswer {
  const shortBytes = Math.max(0, input.estimateBytes - input.creditedBytes - input.freeBytes);
  if (shortBytes === 0) return { verdict: "fits", shortBytes };
  return { verdict: shortBytes <= (input.freeableBytes ?? 0) ? "frees" : "refuse", shortBytes };
}
