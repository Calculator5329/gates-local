const GIB = 1024 ** 3;

/**
 * A card's size from its total, to the nearest GB as cards are sold: 8188 MiB is an 8 GB card,
 * 16303 MiB a 16 GB one. The picker's answer: a size whose estimate is at most this fits; no margin.
 */
export const cardBytes = (totalBytes: number): number => Math.round(totalBytes / GIB) * GIB;

/** On a card smaller than this no setup of the app's runs: there is no default and the picker says so. On the CPU there is one. */
export const MIN_ROOM = 4 * GIB;

export interface ImageFitInput {
  readonly estimateBytes: number;
  readonly freeBytes: number;
  readonly creditedBytes: number;
  readonly freeableBytes?: number;
}

export interface ImageFitAnswer {
  readonly verdict: "fits" | "frees" | "refuse";
  readonly shortBytes: number;
}

/** The job's question: how an image job sits in GPU memory now. No margin: the job runs when its estimate fits. */
export function imageFitVerdict(input: ImageFitInput): ImageFitAnswer {
  const shortBytes = Math.max(0, input.estimateBytes - input.creditedBytes - input.freeBytes);
  if (shortBytes === 0) return { verdict: "fits", shortBytes };
  return { verdict: shortBytes <= (input.freeableBytes ?? 0) ? "frees" : "refuse", shortBytes };
}
