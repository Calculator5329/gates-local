import type { PullProgress } from "@gates-local/contracts";
import { esc } from "../lib/ui/ui.tsx";

const SETTINGS = "Settings · Ctrl ,";

export interface SettingsIcon {
  readonly dot: "amber" | "red" | null;
  readonly tip: string;
  readonly label: string;
  readonly opensRuntime: boolean;
}

// why: the state's sentence is said under its status in Settings › Runtime, where the click goes
export function settingsIcon(rt: { readonly text: string; readonly dot: string } | null): SettingsIcon {
  if (rt === null) return { dot: null, tip: SETTINGS, label: "Settings", opensRuntime: false };
  return { dot: rt.dot === "err" ? "red" : "amber", tip: esc(rt.text), label: `Settings · ${rt.text}`, opensRuntime: true };
}

export interface ModelsIcon {
  readonly state: "idle" | "downloading" | "failed";
  readonly progress: number | null;
  readonly failed: boolean;
  readonly tip: string;
  readonly label: string;
}

const active = (p: PullProgress) => p.state === "queued" || p.state === "downloading" || p.state === "verifying";

// why: the tip is a name and a short status; the sizes and the reason are on the download's row
function status(p: PullProgress): string {
  switch (p.state) {
    case "queued":
      return "Waiting";
    case "verifying":
      return "Checking";
    case "error":
      return "Download failed";
    default:
      return p.totalBytes ? `${Math.floor((p.completedBytes / p.totalBytes) * 100)}%` : "Starting";
  }
}

function tipLine(running: readonly PullProgress[], failed: readonly PullProgress[], nameOf: (tag: string) => string): [name: string, status: string] {
  const all = [...running, ...failed];
  const only = all.length === 1 ? all[0] : undefined;
  if (only !== undefined) return [nameOf(only.name), status(only)];
  const counts = [running.length > 0 ? `${running.length} downloading` : "", failed.length > 0 ? `${failed.length} failed` : ""];
  return ["Models", counts.filter(Boolean).join(" · ")];
}

export function finishedInBurst(kept: readonly PullProgress[], pulls: readonly PullProgress[]): PullProgress[] {
  // why: the burst is over once nothing runs, and the next download starts its own total.
  if (!pulls.some(active)) return [];
  const now = new Map(pulls.map((p) => [p.name, p]));
  const keep = kept.filter((p) => !now.has(p.name));
  return [...keep, ...pulls.filter((p) => p.state === "done" && p.totalBytes)];
}

export function modelsIcon(pulls: readonly PullProgress[], nameOf: (tag: string) => string, finished: readonly PullProgress[] = []): ModelsIcon {
  const running = pulls.filter(active);
  const failed = pulls.filter((p) => p.state === "error");
  if (running.length === 0 && failed.length === 0) return { state: "idle", progress: null, failed: false, tip: "Models", label: "Models" };
  const sized = running.filter((p) => p.totalBytes);
  // why: downloads that finished in this burst count whole, so the ring never goes backwards.
  const whole = running.length > 0 ? finished.reduce((n, p) => n + (p.totalBytes ?? 0), 0) : 0;
  const total = sized.reduce((n, p) => n + (p.totalBytes ?? 0), whole);
  const done = sized.reduce((n, p) => n + Math.min(p.completedBytes, p.totalBytes ?? 0), whole);
  const [what, how] = tipLine(running, failed, nameOf);
  return {
    state: running.length > 0 ? "downloading" : "failed",
    progress: total > 0 ? done / total : null,
    failed: failed.length > 0,
    tip: `<b>${esc(what)}</b> · ${how}`,
    label: what === "Models" ? `Models · ${how}` : `Models · ${what} · ${how}`,
  };
}
