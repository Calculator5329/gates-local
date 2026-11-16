const KEY = "gates-local.model-load-ms";

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
  } catch {}
}

export const loadGuess = (ms: number): string => `~${Math.max(1, Math.round(ms / 1000))} s`;
