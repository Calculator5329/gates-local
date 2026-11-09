import { selectJourneys, type Journey } from "./selection.ts";

/** The journey groups next.spec.ts implements. */
const IMPLEMENTED = new Set<Journey>(["startup", "send", "threads", "parallel", "clipboard", "voice", "queue", "reconnect"]);
export const NEXT_DEFAULT = [...IMPLEMENTED].join(",");

/** A group the spec has no journey for is refused by name; skipping it would report an empty, successful run. */
export function nextJourneys(only: string): Journey[] {
  const selected = selectJourneys(only);
  if (!selected) throw new Error("Choose journeys with --only");
  const missing = selected.filter(journey => !IMPLEMENTED.has(journey));
  if (missing.length) throw new Error(`next.spec.ts has no ${missing.join(" or ")} journey. Leave it out of --only, or measure it with perf:compare.`);
  return selected;
}
