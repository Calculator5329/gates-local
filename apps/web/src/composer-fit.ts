import type { Verdict } from "./format.ts";

/** Keep the composer's verdict steady while its model occupies memory during a load. */
export function composerFit(held: Verdict | undefined, cached: Verdict | "error" | undefined, loading: boolean, fromLoad: boolean): { shown: Verdict | undefined; held: Verdict | undefined } {
  if (cached === "error") return { shown: undefined, held: undefined };
  const fresh = !loading && !fromLoad ? cached : undefined;
  return { shown: fresh ?? held ?? cached, held: fresh ?? held };
}
