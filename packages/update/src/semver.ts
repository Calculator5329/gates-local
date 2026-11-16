export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const RELEASE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseRelease(tag: string): Version | null {
  const m = RELEASE.exec(tag);
  if (m === null) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function compare(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** The newest release tag by version order, or undefined when none is a release. */
export function newestRelease(tags: readonly string[]): string | undefined {
  let best: { tag: string; v: Version } | undefined;
  for (const tag of tags) {
    const v = parseRelease(tag);
    if (v !== null && (best === undefined || compare(v, best.v) > 0)) best = { tag, v };
  }
  return best?.tag;
}
