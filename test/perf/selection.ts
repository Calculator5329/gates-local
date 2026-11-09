export const PRIORITY = ["startup", "send", "threads", "parallel", "clipboard", "voice", "queue", "reconnect", "first-run"] as const;
export type Journey = typeof PRIORITY[number];

/** Omitted means the established broad suite; explicit focus never silently expands. */
export function selectJourneys(only?: string): Journey[] | undefined {
  if (only === undefined) return undefined;
  if (only === "priority") return [...PRIORITY];
  const result: Journey[] = [];
  for (const name of only.split(",")) {
    const journey = PRIORITY.find(item => item === name);
    if (!journey) throw new Error(`Unknown performance journey: ${name}. Use priority or ${PRIORITY.join(",")}`);
    if (!result.includes(journey)) result.push(journey);
  }
  return result;
}
