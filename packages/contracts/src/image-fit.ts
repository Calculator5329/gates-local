// Image fit, two questions. The picker's: does a size fit this card at all? It is judged by the
// card's memory to the nearest GB, never by what is free this second (owner ruling: "the measure
// for a model is not what is available now its based on the ram in the card"), since the chat
// model leaves the GPU before an image loads. The job's (apps/server/src/image/module.ts): once
// everything the app may move has left, does the job fit in what is free now? Other programs can
// still hold memory then, and the job says so in words.

const GIB = 1024 ** 3;

/**
 * A card's size from its total, to the nearest GB as cards are sold: 8188 MiB is an 8 GB card,
 * 16303 MiB a 16 GB one. The picker's answer: a size whose estimate is at most this fits; no margin.
 */
export const cardBytes = (totalBytes: number): number => Math.round(totalBytes / GIB) * GIB;

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

/** The job's question: how an image job sits in GPU memory now. No margin: the job runs when its estimate fits. */
export function imageFitVerdict(input: ImageFitInput): ImageFitAnswer {
  const shortBytes = Math.max(0, input.estimateBytes - input.creditedBytes - input.freeBytes);
  if (shortBytes === 0) return { verdict: "fits", shortBytes };
  return { verdict: shortBytes <= (input.freeableBytes ?? 0) ? "frees" : "refuse", shortBytes };
}
