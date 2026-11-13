// Reads the GPU with nvidia-smi and names who holds it. Read-only: this
// module never signals, stops or reconfigures any process it lists.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { MIB } from "./constants.ts";
import { FitError, type GpuSnapshot, type GpuTenant, type MeminfoReader, type NvidiaSmiRunner } from "./types.ts";

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
    // windowsHide: the server has no console on Windows, so each run would flash one.
    execFile(file, [...leadingArgs, ...args], { timeout: 10_000, maxBuffer: 4 * MIB, windowsHide: true, ...(signal ? { signal } : {}) }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve(stdout);
    });
  });

export const defaultNvidiaSmi = createNvidiaSmiRunner();

/**
 * /proc/meminfo on Linux. Elsewhere (Windows has no /proc) os.totalmem() and os.freemem()
 * rendered as MemTotal and MemAvailable lines, so one parser serves every platform.
 */
export const defaultMeminfo: MeminfoReader = (signal) =>
  process.platform === "linux"
    ? readFile("/proc/meminfo", { encoding: "utf8", ...(signal ? { signal } : {}) })
    : Promise.resolve(`MemTotal: ${Math.floor(os.totalmem() / 1024)} kB\nMemAvailable: ${Math.floor(os.freemem() / 1024)} kB\n`);

/** `work`'s result, or the signal's reason as soon as it aborts (a runner that ignores the signal still lets go). */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) {
    // The work is dropped, not left unobserved: its own rejection must not reach the process.
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
}

/** Parses `--query-gpu=memory.total,memory.used,memory.free` (MiB, no units). */
export function parseGpuTotals(text: string): GpuTotals {
  const rows: { total: number; used: number; free: number }[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const [total, used, free] = line.split(",").map((f) => parseMib(f));
    if (total === undefined || used === undefined || free === undefined) continue;
    rows.push({ total, used, free });
  }
  const first = rows[0];
  if (!first) {
    throw new FitError("gpu-unreadable", `nvidia-smi printed no GPU memory line: ${JSON.stringify(text.slice(0, 200))}`);
  }
  return { totalBytes: first.total, usedBytes: first.used, freeBytes: first.free, gpuCount: rows.length };
}

function labelFor(processName: string): { label: string; role: GpuTenant["role"] } {
  const command = processName.trim().split(/\s+/)[0] ?? processName;
  const base = command.split("/").pop() || command;
  if (/whisper/i.test(base)) return { label: base, role: "whisper" };
  if (/^ollama/i.test(base) || /\/ollama(\/|$)/.test(command)) return { label: base, role: "ollama" };
  if (command.includes("media-vault")) return { label: "media-vault vision runtime", role: "occupant" };
  return { label: base, role: "occupant" };
}

/**
 * Parses `--query-compute-apps=pid,process_name,used_memory`. The process
 * name can itself contain commas, so the pid is the first field, the memory
 * the last, and the name everything between.
 */
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
    const { label, role } = labelFor(processName);
    tenants.push({
      pid: Number(pidText),
      label,
      processName,
      ...(usedBytes === undefined ? {} : { usedBytes }),
      role,
      permanent: role === "whisper",
    });
  }
  return tenants;
}

function errorText(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  return ["message" in error ? error.message : undefined, "stdout" in error ? error.stdout : undefined, "stderr" in error ? error.stderr : undefined]
    .filter((part): part is string => typeof part === "string").join("\n");
}

/** Only the documented unavailable-device messages qualify, never a generic NVML/read error. See gpu-failures.md. */
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

export const gpuReadFailure = (reason: string): string =>
  `Gates Local could not read GPU memory (${reason}), so it cannot check whether a model fits. Try again. If this keeps happening, run nvidia-smi in a terminal to check the NVIDIA driver.`;

/** Resident GPU bytes contradict only nvidia-smi's reported absence, never a missing executable. */
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
  // execFile prefixes its message with the full command. The readers query different columns;
  // keep the diagnostic below that prefix so the same failure has the same words in both places.
  return errorText(error).trim().replace(/^Command failed:[^\n]*(?:\n|$)/i, "").trim().split("\n")[0] || "nvidia-smi command failed";
}

/** Confirm output-based absence and retry quick failures after 250 ms; timeouts, missing commands and aborts never retry. */
export async function readNvidiaSmi<T>(run: NvidiaSmiRunner, totalsArgs: readonly string[], parse: (text: string) => T, signal?: AbortSignal): Promise<SmiRead<T>> {
  let failed = "";
  let firstAbsence: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    if (attempt > 0) await untilAborted(delay(250, undefined, { signal }), signal);
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
      // Readable GPU memory is evidence of a card, even if its process query says no devices.
      if (apps.status === "rejected") throw apps.reason;
      return { kind: "ok", totals: parsed, apps: apps.value };
    } catch (error) {
      failed = readFailure(error);
    }
  }
  return { kind: "unreadable", detail: gpuReadFailure(failed) };
}

/** A finished GPU reading this young (ms, from when it started) is handed to a survey that asks for it instead of running nvidia-smi again. */
export const GPU_REUSE_MS = 500;

/** Bumped by forgetGpuReadings: a reading from an earlier count is never handed out again. */
let generation = 0;

/**
 * The GPU just changed in a way this app knows of (a model loaded or unloaded, the runtime
 * stopped, the GPU watch saw memory move): no caller after this gets a reading taken before it.
 */
export function forgetGpuReadings(): void {
  generation++;
}

interface SharedRead {
  readonly generation: number;
  readonly startedAt: number;
  readonly work: Promise<GpuSnapshot>;
  readonly stop: AbortController;
  /** Callers still waiting that could give up; at 0 after one gives up, the read stops. */
  waiting: number;
  /** A caller with no signal never gives up, so the read always finishes for it. */
  keep: boolean;
}
/** Per runner: the read in flight and the last good one. Keyed by the runner so each server (and each test) has its own. */
const shared = new WeakMap<NvidiaSmiRunner, { live?: SharedRead; last?: { generation: number; startedAt: number; snapshot: GpuSnapshot } }>();

/**
 * The GPU's memory and tenants. Callers at the same time share one pair of nvidia-smi runs (chat
 * row 33: two sends starting at once spent 40% of one core on these runs). A finished reading is
 * handed out again only to a caller that passes `reuseMs` (the fit table and the model list's
 * survey, GPU_REUSE_MS); a send plans on a reading that is in flight or starts now, since it plans
 * again after something it changed (a ComfyUI stop, a claim it waited for). A caller's abort
 * rejects it at once with its reason; the runs stop only when every caller that could give up has,
 * and no caller without a signal is waiting.
 */
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

/** One reading of its own: `signal` reaches both nvidia-smi runs; an abort rejects with its reason. */
async function readGpuNow(run: NvidiaSmiRunner, now: () => number, signal: AbortSignal): Promise<GpuSnapshot> {
  const read = await readNvidiaSmi(run, GPU_TOTALS_ARGS, parseGpuTotals, signal);
  if (read.kind === "unreadable") throw new FitError("gpu-unreadable", read.detail);
  if (read.kind === "none") return { totalBytes: 0, usedBytes: 0, freeBytes: 0, gpuCount: 0, ...(read.detail === undefined ? {} : { unavailableDetail: read.detail }), tenants: [], measuredAt: now() };
  return { ...read.totals, tenants: parseComputeApps(read.apps), measuredAt: now() };
}

/** MemAvailable from /proc/meminfo, in bytes. */
export function parseMemAvailable(text: string): number {
  const match = /^MemAvailable:\s+(\d+)\s*kB/m.exec(text);
  if (!match?.[1]) throw new FitError("meminfo-unreadable", "/proc/meminfo has no MemAvailable line");
  return Number(match[1]) * 1024;
}

/** MemTotal from /proc/meminfo (the computer's memory), in bytes; undefined without the line. */
export function parseMemTotal(text: string): number | undefined {
  const match = /^MemTotal:\s+(\d+)\s*kB/m.exec(text);
  return match?.[1] ? Number(match[1]) * 1024 : undefined;
}

/**
 * The system memory free right now and the memory the computer has, from one reading. A model is
 * judged against the total (the owner's ruling, 2026-11-13); a reading with no MemTotal line
 * takes MemAvailable for it.
 */
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
