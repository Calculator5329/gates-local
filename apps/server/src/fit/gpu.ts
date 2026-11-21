import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { MIB } from "./constants.ts";
import { sendSpan } from "../chat/send-times.ts";
import { FitError, type GpuCard, type GpuSnapshot, type GpuTenant, type MeminfoReader, type NvidiaSmiRunner } from "./types.ts";

export const GPU_TOTALS_ARGS = [
  "--query-gpu=memory.total,memory.used,memory.free",
  "--format=csv,noheader,nounits",
] as const;

export const GPU_APPS_ARGS = [
  "--query-compute-apps=pid,process_name,used_memory",
  "--format=csv,noheader,nounits",
] as const;

export const createNvidiaSmiRunner = (file = "nvidia-smi", leadingArgs: readonly string[] = []): NvidiaSmiRunner => (args, signal) =>
  new Promise((resolve, reject) => {
    // external: Windows opens a console window for each child of a process that has none, unless windowsHide is set.
    execFile(file, [...leadingArgs, ...args], { timeout: 10_000, maxBuffer: 4 * MIB, windowsHide: true, ...(signal ? { signal } : {}) }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve(stdout);
    });
  });

export const defaultNvidiaSmi = createNvidiaSmiRunner();

// external: Windows has no /proc, so there os.totalmem() and os.freemem() are written as MemTotal and MemAvailable lines for the one parser.
export const defaultMeminfo: MeminfoReader = (signal) =>
  process.platform === "linux"
    ? readFile("/proc/meminfo", { encoding: "utf8", ...(signal ? { signal } : {}) })
    : Promise.resolve(`MemTotal: ${Math.floor(os.totalmem() / 1024)} kB\nMemAvailable: ${Math.floor(os.freemem() / 1024)} kB\n`);

export function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) {
    // external: Node ends the process on a rejection that nothing observes.
    work.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function parseMib(field: string | undefined): number | undefined {
  if (field === undefined) return undefined;
  const trimmed = field.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return undefined;
  return Math.round(Number(trimmed) * MIB);
}

export interface GpuTotals {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  gpuCount: number;
  cards?: readonly GpuCard[];
}

// external: Ollama splits a model that does not fit on one card across all of them, so the figures are every card together.
export function parseGpuTotals(text: string): GpuTotals {
  const cards: GpuCard[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const [total, used, free] = line.split(",").map((f) => parseMib(f));
    if (total === undefined || used === undefined || free === undefined) continue;
    cards.push({ totalBytes: total, usedBytes: used, freeBytes: free });
  }
  if (cards.length === 0) {
    throw new FitError("gpu-unreadable", `nvidia-smi printed no GPU memory line: ${JSON.stringify(text.slice(0, 200))}`);
  }
  const sum = (pick: (c: GpuCard) => number) => cards.reduce((s, c) => s + pick(c), 0);
  const all = { totalBytes: sum((c) => c.totalBytes), usedBytes: sum((c) => c.usedBytes), freeBytes: sum((c) => c.freeBytes), gpuCount: cards.length };
  const largestFirst = cards.toSorted((a, b) => b.totalBytes - a.totalBytes);
  return cards.length === 1 ? all : { ...all, cards: largestFirst };
}

export function processBasename(processName: string): string {
  const command = processName.trim().split(/\s+--?\w/)[0]?.trim() ?? processName;
  const base = command.split(/[\\/]/).pop() || command;
  return base.replace(/\.exe$/i, "");
}

// external: nvidia-smi prints a bracketed note where it has no name to give: "[Insufficient Permissions]", "[N/A]", "[Not Found]".
const NO_NAME = /^\[[^\]]*\]$/;

// why: the desktop's own programs are part of the system, never something to close.
const SYSTEM_APPS: readonly [RegExp, string][] = [
  [/^(dwm|explorer|csrss|winlogon|sihost|ctfmon|ShellHost|ShellExperienceHost|StartMenuExperienceHost|SearchHost|SearchApp|TextInputHost|LockApp|ApplicationFrameHost|SystemSettings)$/i, "Windows desktop"],
  [/^kwin/i, "Desktop (KWin)"],
  [/^(gnome-shell|mutter)/i, "Desktop (GNOME)"],
  [/^(Xorg|Xwayland)/i, "Desktop (X server)"],
];

function labelFor(processName: string): Pick<GpuTenant, "label" | "role" | "unnamed" | "system"> {
  const raw = processName.trim();
  if (raw === "" || NO_NAME.test(raw)) return { label: "unnamed process", role: "occupant", unnamed: true };
  const base = processBasename(raw);
  if (/whisper/i.test(base)) return { label: base, role: "whisper" };
  if (/^ollama/i.test(base) || /[\\/]ollama([\\/]|$)/i.test(raw.split(/\s+--?\w/)[0] ?? raw)) return { label: base, role: "ollama" };
  if (/media-vault/i.test(raw)) return { label: "Media Vault vision", role: "occupant" };
  for (const [pattern, label] of SYSTEM_APPS) if (pattern.test(base)) return { label, role: "occupant", system: true };
  return { label: base, role: "occupant" };
}

const MOST_HOLDERS_NAMED = 4;

export function holdersSummary(tenants: readonly Pick<GpuTenant, "label" | "usedBytes">[], size: (bytes: number) => string): string {
  if (tenants.length === 0) return "no process listed";
  const measured = new Map<string, number>();
  let unreported = 0;
  for (const t of tenants) {
    if (t.usedBytes === undefined) unreported++;
    else measured.set(t.label, (measured.get(t.label) ?? 0) + t.usedBytes);
  }
  if (measured.size === 0) return `${unreported} ${unreported === 1 ? "process" : "processes"}, GPU memory not reported per process`;
  const ranked = [...measured].toSorted((a, b) => b[1] - a[1]);
  const parts = ranked.slice(0, MOST_HOLDERS_NAMED).map(([label, bytes]) => `${label} ${size(bytes)}`);
  const rest = ranked.slice(MOST_HOLDERS_NAMED);
  if (rest.length > 0) parts.push(`${rest.length} more ${size(rest.reduce((sum, [, bytes]) => sum + bytes, 0))}`);
  if (unreported > 0) parts.push(`${unreported} more not reported`);
  return parts.join(", ");
}

// external: nvidia-smi does not quote a process name, which can hold commas, so the pid is the first field, the memory the last and the name everything between.
export function parseComputeApps(text: string): GpuTenant[] {
  const tenants: GpuTenant[] = [];
  for (const line of text.split(/\r?\n/)) {
    const first = line.indexOf(",");
    const last = line.lastIndexOf(",");
    if (first < 0 || last <= first) continue;
    const pidText = line.slice(0, first).trim();
    if (!/^\d+$/.test(pidText)) continue;
    const processName = line.slice(first + 1, last).trim();
    const usedBytes = parseMib(line.slice(last + 1));
    const named = labelFor(processName);
    tenants.push({
      pid: Number(pidText),
      processName,
      ...(usedBytes === undefined ? {} : { usedBytes }),
      ...named,
      permanent: named.role === "whisper",
    });
  }
  return tenants;
}

function errorText(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  return ["message" in error ? error.message : undefined, "stdout" in error ? error.stdout : undefined, "stderr" in error ? error.stderr : undefined]
    .filter((part): part is string => typeof part === "string").join("\n");
}

function noUsableGpu(error: unknown): { kind: "none"; detail?: string } | undefined {
  let reason: string;
  if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return { kind: "none" };
  else {
    const text = typeof error === "string" ? error : errorText(error);
    if (/(^|\n)\s*No devices were found\.?\s*($|\n)/i.test(text)) reason = "nvidia-smi found no NVIDIA GPU";
    else if (/NVIDIA-SMI has failed because it couldn't communicate with (?:the )?NVIDIA driver\b/i.test(text)) reason = "nvidia-smi couldn't communicate with the NVIDIA driver";
    else return undefined;
  }
  return { kind: "none", detail: `${reason}. If this computer has an NVIDIA card, its driver is not answering: fix or reinstall the NVIDIA driver. Until then models run in system memory.` };
}

type SmiRead<T> = { kind: "ok"; totals: T; apps: string } | { kind: "none"; detail?: string } | { kind: "unreadable"; detail: string };

// external: nvidia-smi says this when the driver's files are newer than the module the kernel loaded
const DRIVER_UPDATED = /Driver\/library version mismatch/i;

export const gpuReadFailure = (reason: string): string => DRIVER_UPDATED.test(reason)
  ? "The NVIDIA driver was updated and needs a restart, so Gates Local cannot read GPU memory (nvidia-smi: Driver/library version mismatch). Restart the computer."
  : `Gates Local could not read GPU memory (${reason}), so it cannot check whether a model fits. Try again. If this keeps happening, run nvidia-smi in a terminal to check the NVIDIA driver.`;

export function gpuReadingConflict(unavailableDetail: string | undefined, residentVramBytes: readonly number[]): string | undefined {
  return unavailableDetail !== undefined && residentVramBytes.some(bytes => bytes > 0)
    ? gpuReadFailure("Ollama reports a model in GPU memory, but nvidia-smi found no usable NVIDIA GPU") : undefined;
}

function isSmiTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (("code" in error && error.code === "ETIMEDOUT") ||
      ("code" in error && error.code === null && "killed" in error && error.killed === true && "signal" in error && error.signal === "SIGTERM"));
}

function readFailure(error: unknown): string {
  if (error instanceof FitError) return "nvidia-smi printed no GPU memory line";
  if (isSmiTimeout(error)) return "nvidia-smi timed out";
  // external: Node's execFile starts its error message with "Command failed:" and the whole command, and the two readers' commands differ.
  return errorText(error).trim().replace(/^Command failed:[^\n]*(?:\n|$)/i, "").trim().split("\n")[0] || "nvidia-smi command failed";
}

const RETRY_PAUSE_MS = 250;

export async function readNvidiaSmi<T>(run: NvidiaSmiRunner, totalsArgs: readonly string[], parse: (text: string) => T, signal?: AbortSignal): Promise<SmiRead<T>> {
  let failed = "";
  let firstAbsence: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    if (attempt > 0) await untilAborted(delay(RETRY_PAUSE_MS, undefined, { signal }), signal);
    const [totals, apps] = await untilAborted(Promise.allSettled([run(totalsArgs, signal), run(GPU_APPS_ARGS, signal)]), signal);
    signal?.throwIfAborted();
    const timedOut = [totals, apps].some(result => result.status === "rejected" && isSmiTimeout(result.reason));
    if (timedOut) { failed = "nvidia-smi timed out"; break; }
    const unavailable = noUsableGpu(totals.status === "rejected" ? totals.reason : totals.value);
    if (unavailable !== undefined) {
      if (attempt === 0 && unavailable.detail === undefined) return unavailable;
      if (attempt === 1 && firstAbsence !== undefined && firstAbsence === unavailable.detail) return unavailable;
      if (attempt === 0) { firstAbsence = unavailable.detail; continue; }
    }
    if (firstAbsence !== undefined || unavailable !== undefined) {
      failed = "GPU availability changed between readings";
      break;
    }
    try {
      if (totals.status === "rejected") throw totals.reason;
      const parsed = parse(totals.value);
      if (apps.status === "rejected") throw apps.reason;
      return { kind: "ok", totals: parsed, apps: apps.value };
    } catch (error) {
      failed = readFailure(error);
    }
  }
  return { kind: "unreadable", detail: gpuReadFailure(failed) };
}

export const GPU_REUSE_MS = 500;

// why: bumped whenever the app knows the GPU changed, so an older reading is never handed out.
let generation = 0;

export function forgetGpuReadings(): void {
  generation++;
}

interface SharedRead {
  readonly generation: number;
  readonly startedAt: number;
  readonly work: Promise<GpuSnapshot>;
  readonly stop: AbortController;
  // why: counts only callers that could give up; at 0 after one gives up, the read stops.
  waiting: number;
  // why: a caller with no signal never gives up, so the read always finishes for it.
  keep: boolean;
}
// why: keyed by the runner so each server, and each test, has its own reads.
const shared = new WeakMap<NvidiaSmiRunner, { live?: SharedRead; last?: { generation: number; startedAt: number; snapshot: GpuSnapshot } }>();

export async function readGpu(run: NvidiaSmiRunner = defaultNvidiaSmi, now: () => number = Date.now, signal?: AbortSignal, reuseMs = 0): Promise<GpuSnapshot> {
  signal?.throwIfAborted();
  const calledAt = performance.now();
  let state = shared.get(run);
  if (state === undefined) shared.set(run, state = {});
  const last = state.last;
  if (last !== undefined && last.generation === generation && calledAt - last.startedAt < reuseMs) return last.snapshot;
  let live = state.live;
  if (live === undefined || live.generation !== generation) {
    const stop = new AbortController();
    const entry = state;
    const work = readGpuNow(run, now, stop.signal);
    const started: SharedRead = { generation, startedAt: calledAt, work, stop, waiting: 0, keep: false };
    work.then(snapshot => {
      if (entry.last === undefined || entry.last.startedAt <= started.startedAt) entry.last = { generation: started.generation, startedAt: started.startedAt, snapshot };
    }, () => undefined).finally(() => { if (entry.live === started) delete entry.live; });
    state.live = live = started;
  }
  if (signal === undefined) { live.keep = true; return live.work; }
  const mine = live;
  mine.waiting++;
  const giveUp = () => { if (--mine.waiting === 0 && !mine.keep) mine.stop.abort(signal.reason); };
  signal.addEventListener("abort", giveUp, { once: true });
  try {
    return await untilAborted(mine.work, signal);
  } finally {
    signal.removeEventListener("abort", giveUp);
  }
}

async function readGpuNow(run: NvidiaSmiRunner, now: () => number, signal: AbortSignal): Promise<GpuSnapshot> {
  const read = await sendSpan("nvidia-smi", () => readNvidiaSmi(run, GPU_TOTALS_ARGS, parseGpuTotals, signal));
  if (read.kind === "unreadable") throw new FitError("gpu-unreadable", read.detail);
  if (read.kind === "none") return { totalBytes: 0, usedBytes: 0, freeBytes: 0, gpuCount: 0, ...(read.detail === undefined ? {} : { unavailableDetail: read.detail }), tenants: [], measuredAt: now() };
  return { ...read.totals, tenants: parseComputeApps(read.apps), measuredAt: now() };
}

export function parseMemAvailable(text: string): number {
  const match = /^MemAvailable:\s+(\d+)\s*kB/m.exec(text);
  if (!match?.[1]) throw new FitError("meminfo-unreadable", "/proc/meminfo has no MemAvailable line");
  return Number(match[1]) * 1024;
}

export function parseMemTotal(text: string): number | undefined {
  const match = /^MemTotal:\s+(\d+)\s*kB/m.exec(text);
  return match?.[1] ? Number(match[1]) * 1024 : undefined;
}

export interface MemoryReading {
  readonly availableBytes: number;
  readonly totalBytes: number;
}

export async function readMemory(read: MeminfoReader = defaultMeminfo, signal?: AbortSignal): Promise<MemoryReading> {
  signal?.throwIfAborted();
  let text: string;
  try {
    text = await untilAborted(read(signal), signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new FitError("meminfo-unreadable", `cannot read /proc/meminfo: ${error instanceof Error ? error.message : String(error)}`);
  }
  const availableBytes = parseMemAvailable(text);
  return { availableBytes, totalBytes: parseMemTotal(text) ?? availableBytes };
}

export async function readMemAvailable(read: MeminfoReader = defaultMeminfo, signal?: AbortSignal): Promise<number> {
  return (await readMemory(read, signal)).availableBytes;
}
