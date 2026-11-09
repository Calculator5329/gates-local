export interface BlockSnap {
  readonly tag: string;
  readonly text: string;
}

const words = (text: string) => text.replace(/[|\s]/g, "");

/** Completed blocks stay fixed. The active header can remain prose until a
 * delimiter proves its table; the header's words still prefix the final table. */
export function blockPrefix(sample: readonly BlockSnap[], final: readonly BlockSnap[]): boolean {
  if (sample.length > final.length) return false;
  return sample.every((b, i) => {
    const f = final[i];
    if (f === undefined) return false;
    if (b.tag !== f.tag) {
      return i === sample.length - 1 && b.tag === "P" && f.tag === "TABLE" && words(f.text).startsWith(words(b.text));
    }
    if (b.text === f.text) return true;
    return i === sample.length - 1 && f.text.startsWith(b.text);
  });
}
