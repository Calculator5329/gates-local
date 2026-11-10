export const PRIORITY = ["startup", "send", "threads", "parallel", "clipboard", "voice", "queue", "reconnect", "first-run"] as const;
export const JOURNEYS = [...PRIORITY, "desktop-launch", "picker", "typing"] as const;
export type Journey = typeof JOURNEYS[number];

export const THREAD_WINDOW_NOTE = "Row meaning changed since v0.1.0: open-thread-200 and open-thread-2000 now end at the last turn's text in view (first screen), rather than every turn mounted. Their -mounted twins measure the whole fill from the same click. Both arms use these new windows; old release reports are not directly comparable. Focused thread-<n>-<warmth>-<path> rows use the same two windows.";

/** Omitted means the established broad suite; explicit focus never silently expands. */
export function selectJourneys(only?: string): Journey[] | undefined {
  if (only === undefined) return undefined;
  if (only === "priority") return [...PRIORITY];
  const result: Journey[] = [];
  for (const name of only.split(",")) {
    const journey = JOURNEYS.find(item => item === name);
    if (!journey) throw new Error(`Unknown performance journey: ${name}. Use priority or ${JOURNEYS.join(",")}`);
    if (!result.includes(journey)) result.push(journey);
  }
  return result;
}
