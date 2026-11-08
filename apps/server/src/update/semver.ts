// Release tags: v<major>.<minor>.<patch>, compared as numbers, so v0.10.0
// comes after v0.9.0. A tag with anything after the patch number (v1.0.0-rc.1,
// v1.0.0-beta) is a pre-release and never a release-channel target; a tag
// that is not of this form (v1, version-2) is ignored.

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
