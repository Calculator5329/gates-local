// Reads the GPU with nvidia-smi and names who holds it. Read-only: this
// module never signals, stops or reconfigures any process it lists.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
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

export const defaultNvidiaSmi: NvidiaSmiRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile("nvidia-smi", [...args], { timeout: 10_000, maxBuffer: 4 * MIB }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });

/**
 * /proc/meminfo on Linux. Elsewhere (Windows has no /proc) os.freemem()
 * rendered as a MemAvailable line, so one parser serves every platform.
 */
export const defaultMeminfo: MeminfoReader = () =>
  process.platform === "linux" ? readFile("/proc/meminfo", "utf8") : Promise.resolve(`MemAvailable: ${Math.floor(os.freemem() / 1024)} kB\n`);

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

export async function readGpu(run: NvidiaSmiRunner = defaultNvidiaSmi, now: () => number = Date.now): Promise<GpuSnapshot> {
  let totalsText: string;
  let appsText: string;
  try {
    [totalsText, appsText] = await Promise.all([run(GPU_TOTALS_ARGS), run(GPU_APPS_ARGS)]);
  } catch (error) {
    // No nvidia-smi at all (Windows on Geordi, a machine with no NVIDIA GPU):
    // zero VRAM, so the fit check plans the whole model in system memory.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { totalBytes: 0, usedBytes: 0, freeBytes: 0, gpuCount: 0, tenants: [], measuredAt: now() };
    throw new FitError("gpu-unreadable", `nvidia-smi failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const totals = parseGpuTotals(totalsText);
  return { ...totals, tenants: parseComputeApps(appsText), measuredAt: now() };
}

/** MemAvailable from /proc/meminfo, in bytes. */
export function parseMemAvailable(text: string): number {
  const match = /^MemAvailable:\s+(\d+)\s*kB/m.exec(text);
  if (!match?.[1]) throw new FitError("meminfo-unreadable", "/proc/meminfo has no MemAvailable line");
  return Number(match[1]) * 1024;
}

export async function readMemAvailable(read: MeminfoReader = defaultMeminfo): Promise<number> {
  let text: string;
  try {
    text = await read();
  } catch (error) {
    throw new FitError("meminfo-unreadable", `cannot read /proc/meminfo: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseMemAvailable(text);
}
