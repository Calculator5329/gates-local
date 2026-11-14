// The sidebar footer's Settings and Models icons, as pure functions of the
// runtime row's words and the store's model downloads.
import type { PullProgress } from "@gates-local/contracts";
import { NBSP, gb } from "./format.ts";
import { esc } from "./ui.tsx";

const SETTINGS = "Settings · Ctrl ,";

export interface SettingsIcon {
  readonly dot: "amber" | "red" | null;
  readonly tip: string;
  readonly label: string;
  /** The click opens Settings › Runtime, as the runtime row did. */
  readonly runtime: boolean;
}

/**
 * The gear. A runtime that is not ready (rt is the runtime row's words: text
 * plain, tip HTML as rtInfo builds it, dot its colour) adds a dot and leads the
 * tooltip; null when the runtime is ready.
 */
export function settingsIcon(rt: { readonly text: string; readonly tip: string; readonly dot: string } | null): SettingsIcon {
  if (rt === null) return { dot: null, tip: SETTINGS, label: "Settings", runtime: false };
  return { dot: rt.dot === "err" ? "red" : "amber", tip: `<b>${esc(rt.text)}</b><br>${rt.tip === "" ? "" : `${rt.tip}<br>`}${SETTINGS}`, label: `Settings · ${rt.text}`, runtime: true };
}

export interface ModelsIcon {
  readonly state: "idle" | "downloading" | "failed";
  /** The ring: the share of all running downloads' bytes, or null for a turning arc when no size is known yet. */
  readonly progress: number | null;
  /** A download failed: red dot (and a red icon when nothing else runs). */
  readonly failed: boolean;
  readonly tip: string;
  readonly label: string;
}

const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const active = (p: PullProgress) => p.state === "queued" || p.state === "downloading" || p.state === "verifying";

/** One line per download: [bold part, rest], both already escaped. */
function line(p: PullProgress, name: string): [string, string] {
  const n = esc(name);
  switch (p.state) {
    case "queued":
      return [n, " is waiting to download"];
    case "verifying":
      return [`Checking ${n}`, " after downloading it"];
    case "error":
      return [`${n} did not finish downloading.`, p.message ? ` ${esc(p.message)}` : ""];
    default: {
      if (!p.totalBytes) return [`Starting the download of ${n}`, ""];
      const pct = Math.floor((p.completedBytes / p.totalBytes) * 100);
      return [`Downloading ${n}`, ` · ${pct}% · ${gb(p.completedBytes).replace(`${NBSP}GB`, "")} of ${gb(p.totalBytes)}`];
    }
  }
}

/**
 * The downloads that finished during the current burst (since the last moment
 * none ran), kept after the store lets them go so the ring's total never
 * shrinks. Empty once nothing runs; a cancelled download is not kept.
 */
export function finishedInBurst(kept: readonly PullProgress[], pulls: readonly PullProgress[]): PullProgress[] {
  const running = pulls.filter(active);
  if (running.length === 0) return [];
  const now = new Map(pulls.map((p) => [p.name, p]));
  const keep = kept.filter((p) => !now.has(p.name));
  return [...keep, ...pulls.filter((p) => p.state === "done" && p.totalBytes)];
}

/** The chip. nameOf turns a tag into the catalog's name. Failures listed here are the ones the person has not seen in Settings › Models yet; finished are the burst's (finishedInBurst), counted whole in the ring. */
export function modelsIcon(pulls: readonly PullProgress[], nameOf: (tag: string) => string, finished: readonly PullProgress[] = []): ModelsIcon {
  const running = pulls.filter(active);
  const failed = pulls.filter((p) => p.state === "error");
  if (running.length === 0 && failed.length === 0) return { state: "idle", progress: null, failed: false, tip: "Models", label: "Models" };
  const sized = running.filter((p) => p.totalBytes);
  const whole = running.length > 0 ? finished.reduce((n, p) => n + (p.totalBytes ?? 0), 0) : 0;
  const total = sized.reduce((n, p) => n + (p.totalBytes ?? 0), whole);
  const done = sized.reduce((n, p) => n + Math.min(p.completedBytes, p.totalBytes ?? 0), whole);
  const ls = [...running, ...failed].map((p) => line(p, nameOf(p.name)));
  return {
    state: running.length > 0 ? "downloading" : "failed",
    progress: total > 0 ? done / total : null,
    failed: failed.length > 0,
    tip: ls.map(([b, rest]) => `<b>${b}</b>${rest}`).join("<br>"),
    label: `Models · ${ls.map(([b, rest]) => unescape(b + rest)).join(". ")}`,
  };
}
