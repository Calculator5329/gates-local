import type { PullProgress } from "@gates-local/contracts";
import { NBSP, gb } from "../lib/words/format.ts";
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

const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const active = (p: PullProgress) => p.state === "queued" || p.state === "downloading" || p.state === "verifying";

function tipLine(p: PullProgress, name: string): [boldEscaped: string, restEscaped: string] {
  const n = esc(name);
  switch (p.state) {
    case "queued":
      return [n, " is waiting to download"];
    case "verifying":
      return [`Checking ${n}`, " after downloading it"];
    case "error":
      // why: the reason is on the download's row in Settings; the tip is the short status
      return [n, " · Download failed"];
    default: {
      if (!p.totalBytes) return [`Starting the download of ${n}`, ""];
      const pct = Math.floor((p.completedBytes / p.totalBytes) * 100);
      return [`Downloading ${n}`, ` · ${pct}% · ${gb(p.completedBytes).replace(`${NBSP}GB`, "")} of ${gb(p.totalBytes)}`];
    }
  }
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
  const lines = [...running, ...failed].map((p) => tipLine(p, nameOf(p.name)));
  return {
    state: running.length > 0 ? "downloading" : "failed",
    progress: total > 0 ? done / total : null,
    failed: failed.length > 0,
    tip: lines.map(([bold, rest]) => `<b>${bold}</b>${rest}`).join("<br>"),
    label: `Models · ${lines.map(([bold, rest]) => unescape(bold + rest)).join(". ")}`,
  };
}
