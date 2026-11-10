import { selectJourneys, type Journey } from "./selection.ts";

/** The journey groups next.spec.ts implements. */
const IMPLEMENTED = new Set<Journey>(["startup", "send", "threads", "parallel", "clipboard", "voice", "queue", "reconnect"]);
export const NEXT_DEFAULT = [...IMPLEMENTED].join(",");

export type RepetitionKind = "timed" | "counters" | "profile";
/**
 * Three. The scorer deals values between arms within each repetition position,
 * so one counter repetition per run over four rounds is one stratum of four
 * against four: 70 arrangements, and p can never fall under 1 in 100. Two
 * strata allow it in principle, but the lower quartile ties across many
 * arrangements, so even arms that do not overlap at all land near p = 0.009
 * and miss about one time in nine. Three strata put them near p = 0.002.
 */
export const COUNTER_REPETITIONS = 3;

/** What each browser context of one run does, in order. */
export function repetitionPlan(timed: number, round: number): RepetitionKind[] {
  return [
    ...Array.from({ length: timed }, (): RepetitionKind => "timed"),
    ...Array.from({ length: COUNTER_REPETITIONS }, (): RepetitionKind => "counters"),
    ...round === 1 ? ["profile" as const] : [],
  ];
}

/** A group the spec has no journey for is refused by name; skipping it would report an empty, successful run. */
export function nextJourneys(only: string): Journey[] {
  const selected = selectJourneys(only);
  if (!selected) throw new Error("Choose journeys with --only");
  const missing = selected.filter(journey => !IMPLEMENTED.has(journey));
  if (missing.length) throw new Error(`next.spec.ts has no ${missing.join(" or ")} journey. Leave it out of --only, or measure it with perf:compare.`);
  return selected;
}
