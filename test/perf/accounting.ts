import { createReadStream, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Observation } from "./probe.ts";

export const CPU_ROLES = ["server", "page", "browser-other", "fake", "driver", "gpu"] as const;
type CpuRole = typeof CPU_ROLES[number] | "unassigned";
type CpuTotals = Record<CpuRole, number>;
export interface JourneyWindow extends Pick<Observation, "epochStart" | "epochEnd"> { name: string; kind: string; repeat: number; elapsed: number }
type Thread = [pid: number, birth: string, tid: number, role: CpuRole, runtime: number, boxed: boolean, affinity: number[]];
interface CpuSample { epochMs: number; scanMs: number; rows: Thread[]; boxCpuNs: number | null }
export interface JourneyCpu extends JourneyWindow {
  insideMs: CpuTotals;
  outsideMs: CpuTotals;
  boxCpuMs: number | null;
  /** Cgroup CPU minus all sampled in-box threads, including unknown roles. Signed. */
  differenceMs: number | null;
  /** Cgroup CPU minus the six named in-box roles. Signed, includes unknown/missed work. */
  unassignedMs: number | null;
  coveredMs: number;
  maxGapMs: number;
  maxScanMs: number;
}
const empty = (): CpuTotals => ({ server: 0, page: 0, "browser-other": 0, fake: 0, driver: 0, gpu: 0, unassigned: 0 });
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
function thread(value: unknown): value is Thread {
  return Array.isArray(value) && value.length === 7 && finite(value[0]) && typeof value[1] === "string" && finite(value[2])
    && [...CPU_ROLES, "unassigned"].includes(value[3]) && finite(value[4]) && typeof value[5] === "boolean" && Array.isArray(value[6]) && value[6].every(finite);
}
export function parseCpuSample(text: string): CpuSample {
  const value: unknown = JSON.parse(text);
  if (!object(value) || !finite(value["epochMs"]) || !finite(value["scanMs"]) || !Array.isArray(value["rows"]) || !value["rows"].every(thread)
    || !(value["boxCpuNs"] === null || finite(value["boxCpuNs"]))) throw new Error("Unreadable performance CPU sample");
  return { epochMs: value["epochMs"], scanMs: value["scanMs"], rows: value["rows"], boxCpuNs: value["boxCpuNs"] };
}
export function parseJourneyWindow(text: string): JourneyWindow {
  const value: unknown = JSON.parse(text);
  if (!object(value) || typeof value["name"] !== "string" || typeof value["kind"] !== "string" || !finite(value["repeat"]) || !finite(value["elapsed"])
    || !finite(value["epochStart"]) || !finite(value["epochEnd"]) || value["epochEnd"] < value["epochStart"])
    throw new Error("Unreadable performance journey marks");
  return { name: value["name"], kind: value["kind"], repeat: value["repeat"], elapsed: value["elapsed"], epochStart: value["epochStart"], epochEnd: value["epochEnd"] };
}

/** Interpolate cumulative counters at the page's own event/paint marks. */
export async function accountWindows(windows: readonly JourneyWindow[], samples: AsyncIterable<CpuSample> | Iterable<CpuSample>): Promise<JourneyCpu[]> {
  const results: JourneyCpu[] = windows.map(window => ({ ...window, insideMs: empty(), outsideMs: empty(), boxCpuMs: null, differenceMs: null, unassignedMs: null, coveredMs: 0, maxGapMs: 0, maxScanMs: 0 }));
  let previous: CpuSample | undefined;
  for await (const sample of samples) {
    if (previous) {
      const gap = sample.epochMs - previous.epochMs;
      if (gap <= 0) throw new Error("Performance CPU samples are out of order");
      const active = results.filter(window => window.epochStart !== undefined && window.epochEnd !== undefined && window.epochStart < sample.epochMs && window.epochEnd > previous!.epochMs);
      if (active.length) {
        const key = (row: Thread) => `${row[0]}:${row[1]}:${row[2]}`;
        const before = new Map(previous.rows.map(row => [key(row), row]));
        const deltas = sample.rows.flatMap(row => {
          const start = before.get(key(row));
          // Exited/new threads and migrations cannot safely be interpolated.
          return start && start[5] === row[5] && row[4] >= start[4] ? [{ row, ms: (row[4] - start[4]) / 1e6 }] : [];
        });
        for (const window of active) {
          const overlap = Math.min(window.epochEnd!, sample.epochMs) - Math.max(window.epochStart!, previous.epochMs);
          const fraction = overlap / gap;
          window.maxGapMs = Math.max(window.maxGapMs, gap);
          window.maxScanMs = Math.max(window.maxScanMs, previous.scanMs, sample.scanMs);
          for (const { row, ms } of deltas) (row[5] ? window.insideMs : window.outsideMs)[row[3]] += ms * fraction;
          if (previous.boxCpuNs !== null && sample.boxCpuNs !== null && sample.boxCpuNs >= previous.boxCpuNs) {
            window.boxCpuMs = (window.boxCpuMs ?? 0) + (sample.boxCpuNs - previous.boxCpuNs) / 1e6 * fraction;
            window.coveredMs += overlap;
          }
        }
      }
    }
    previous = sample;
  }
  for (const window of results) if (window.boxCpuMs !== null) {
    window.differenceMs = window.boxCpuMs - Object.values(window.insideMs).reduce((sum, ms) => sum + ms, 0);
    window.unassignedMs = window.boxCpuMs - CPU_ROLES.reduce((sum, role) => sum + window.insideMs[role], 0);
  }
  return results;
}

export async function readAccounting(out: string): Promise<JourneyCpu[]> {
  const windowsFile = path.join(out, "windows.jsonl");
  if (!existsSync(windowsFile)) throw new Error("The limited arm recorded no journey marks");
  const windows = readFileSync(windowsFile, "utf8").trim().split("\n").map(parseJourneyWindow);
  async function* samples() {
    const lines = createInterface({ input: createReadStream(path.join(out, "cpu.jsonl")), crlfDelay: Infinity });
    for await (const line of lines) yield parseCpuSample(line);
  }
  return accountWindows(windows, samples());
}

/** Limited arms only. Outside CPU overlaps the app and cannot partition wall time. */
export function accountingMarkdown(arms: Record<"base" | "candidate", readonly JourneyCpu[]>): string {
  if (!arms.base.length && !arms.candidate.length) return "";
  const lines = ["", "Limited-arm processor work (mean milliseconds per marked window; inside / outside). Outside work overlaps wall time.", "",
    "| Arm / action | Wall | Server | Page | Browser rest | Fake | Driver | GPU stand-in | Unassigned inside | Cgroup CPU | Cgroup minus sampled | Coverage % | Max gap | Max scan |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"];
  for (const arm of ["base", "candidate"] as const) {
    const timed = arms[arm].filter(window => window.kind === "timed");
    for (const name of new Set(timed.map(window => window.name))) {
      const windows = timed.filter(window => window.name === name);
      const mean = (get: (window: JourneyCpu) => number | null) => windows.some(window => get(window) === null) ? "n/a" : (windows.reduce((sum, window) => sum + (get(window) ?? 0), 0) / windows.length).toFixed(1);
      lines.push(`| ${arm} / ${name} | ${mean(w => w.elapsed)} | ${CPU_ROLES.map(role => `${mean(w => w.insideMs[role])} / ${mean(w => w.outsideMs[role])}`).join(" | ")} | ${mean(w => w.unassignedMs)} | ${mean(w => w.boxCpuMs)} | ${mean(w => w.differenceMs)} | ${mean(w => w.elapsed ? w.coveredMs / w.elapsed * 100 : 100)} | ${Math.max(...windows.map(w => w.maxGapMs)).toFixed(1)} | ${Math.max(...windows.map(w => w.maxScanMs)).toFixed(1)} |`);
    }
  }
  lines.push("", "Unassigned and cgroup-minus-sampled are signed: sampling can overcount as well as miss short-lived threads. Partial coverage is not a complete-window CPU reading.");
  return lines.join("\n") + "\n";
}
