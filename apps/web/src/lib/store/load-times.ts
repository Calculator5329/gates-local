// How long each model took to load on this machine: from the server's
// "loading" notice to its "ready", as this browser saw them. The model
// button's bar fills over the last one (chat row 16); a model with none
// gets a counter instead, since nothing true can be said about its end.
const KEY = "gates-local.model-load-ms";

/** The saved times by model tag, in milliseconds; empty when storage is unavailable or holds something else. */
export function readLoadTimes(): Readonly<Record<string, number>> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1]) && e[1] > 0));
  } catch {
    return {};
  }
}

export function saveLoadTimes(times: Readonly<Record<string, number>>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(times));
  } catch {
    /* this session still uses the time when storage is unavailable */
  }
}

/** "~4 s": the last load's length, whole seconds, at least one. */
export const loadGuess = (ms: number): string => `~${Math.max(1, Math.round(ms / 1000))} s`;
