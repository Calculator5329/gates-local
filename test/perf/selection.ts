export const PRIORITY = ["startup", "send", "threads", "parallel", "clipboard", "voice", "queue", "reconnect", "first-run"] as const;
export const JOURNEYS = [...PRIORITY, "desktop-launch"] as const;
export type Journey = typeof JOURNEYS[number];

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
