import { execFile } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import os from "node:os";
import type { GpuOccupant, GpuStatus } from "@gates-local/contracts";
import { MIB } from "./constants.ts";
import { defaultNvidiaSmi, gpuReadingConflict, parseComputeApps, parseMemAvailable, processBasename, readNvidiaSmi } from "./gpu.ts";
import { FitError, type GpuTenant, type MeminfoReader, type NvidiaSmiRunner } from "./types.ts";

export const GPU_STATUS_ARGS = ["--query-gpu=name,memory.total,memory.used,memory.free", "--format=csv,noheader,nounits"] as const;

// external: ComfyUI listens on 8188 unless it is started with another port.
export const COMFYUI_PORT = 8188;

// why: less than this that nvidia-smi cannot attribute is noise, not an occupant.
const UNKNOWN_MIN_BYTES = 64 * MIB;

export interface ResidentModel {
  name: string;
  sizeVramBytes: number;
}

export interface GpuStatusDeps {
  platform?: NodeJS.Platform;
  runNvidiaSmi?: NvidiaSmiRunner;
  readMeminfo?: MeminfoReader;
  freemem?: () => number;
  whisperPid?: () => Promise<number | undefined>;
  residentModels?: () => Promise<readonly ResidentModel[]>;
  listeningPids?: (port: number, pids: readonly number[]) => Promise<ReadonlySet<number>>;
  imagePid?: () => number | undefined;
  modelLabel?: (tag: string) => string;
  mayUnload?: () => readonly string[];
  now?: () => number;
}

const isPython = (processName: string) => /python|comfy/i.test(processBasename(processName));

function parseStatusTotals(text: string): { name: string; totalBytes: number; usedBytes: number; freeBytes: number } {
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 4) continue;
    const [total, used, free] = parts.slice(-3).map((p) => (/^\d+(\.\d+)?$/.test(p) ? Math.round(Number(p) * MIB) : undefined));
    if (total === undefined || used === undefined || free === undefined) continue;
    return { name: parts.slice(0, -3).join(","), totalBytes: total, usedBytes: used, freeBytes: free };
  }
  throw new FitError("gpu-unreadable", "nvidia-smi printed no GPU memory line");
}

async function procMemAvailable(deps: GpuStatusDeps): Promise<number | undefined> {
  try {
    return parseMemAvailable(await (deps.readMeminfo ?? (() => readFile("/proc/meminfo", "utf8")))());
  } catch {
    // why: an unreadable /proc/meminfo leaves the portable reading to answer.
    return undefined;
  }
}

async function systemMemoryAvailable(deps: GpuStatusDeps, platform: NodeJS.Platform): Promise<number> {
  const fromProc = platform === "linux" ? await procMemAvailable(deps) : undefined;
  return fromProc ?? (deps.freemem ?? os.freemem)();
}

function chatOccupants(runnerBytes: number, models: readonly ResidentModel[], label: (tag: string) => string, mayBeAskedToLeave: (tag: string) => boolean): GpuOccupant[] {
  if (models.length === 0) return runnerBytes > 0 ? [{ label: "Ollama", bytes: runnerBytes, kind: "chat-model", protected: true }] : [];
  const vramSum = models.reduce((s, m) => s + m.sizeVramBytes, 0);
  const total = Math.max(runnerBytes, vramSum);
  return models.map((m) => ({
    label: label(m.name),
    bytes: Math.round(vramSum > 0 ? (total * m.sizeVramBytes) / vramSum : total / models.length),
    kind: "chat-model" as const,
    protected: !mayBeAskedToLeave(m.name),
  }));
}

export function holdersOf(
  tenants: readonly GpuTenant[],
  usedBytes: number,
  is: { whisper?: (t: GpuTenant) => boolean; image?: (t: GpuTenant) => boolean } = {},
): { holders: GpuOccupant[]; runnerBytes: number } {
  let runnerBytes = 0;
  let accounted = 0;
  const grouped = new Map<string, GpuOccupant>();
  const add = (o: GpuOccupant) => {
    const key = `${o.kind}\0${o.label}`;
    const prev = grouped.get(key);
    grouped.set(key, prev ? { ...prev, bytes: prev.bytes + o.bytes } : o);
  };
  for (const t of tenants) {
    // external: nvidia-smi gives no memory for any process on Windows, nor for one it may not inspect.
    if (t.usedBytes === undefined) continue;
    const bytes = t.usedBytes;
    accounted += bytes;
    if (t.role === "whisper" || is.whisper?.(t) === true) add({ label: "Whisper", bytes, kind: "whisper", protected: true });
    else if (t.role === "ollama") runnerBytes += bytes;
    else if (is.image?.(t) === true) add({ label: "ComfyUI", bytes, kind: "image", protected: false });
    // why: measured but with no name, so it joins the remainder.
    else if (t.unnamed) accounted -= bytes;
    else add({ label: t.label, bytes, kind: "other-app", protected: true });
  }
  const holders = [...grouped.values()];
  const unknown = usedBytes - accounted;
  if (unknown >= UNKNOWN_MIN_BYTES) holders.push({ label: "Not attributed to a process", bytes: unknown, kind: "unknown", protected: true });
  holders.sort((a, b) => b.bytes - a.bytes);
  return { holders, runnerBytes };
}

export async function readGpuStatus(deps: GpuStatusDeps = {}): Promise<GpuStatus> {
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const run = deps.runNvidiaSmi ?? defaultNvidiaSmi;
  const [smi, memAvail, models] = await Promise.all([
    readNvidiaSmi(run, GPU_STATUS_ARGS, parseStatusTotals),
    systemMemoryAvailable(deps, platform),
    (deps.residentModels ?? (async () => []))().catch(() => [] as readonly ResidentModel[]),
  ]);
  const base = { systemMemoryAvailableBytes: Math.max(0, Math.round(memAvail)), measuredAt: now() };
  const conflict = gpuReadingConflict(smi.kind === "none" ? smi.detail : undefined, models.map(model => model.sizeVramBytes));
  if (conflict !== undefined) return { vendor: "unreadable", occupants: [], ...base, detail: conflict };
  if (smi.kind !== "ok") return { vendor: smi.kind, occupants: [], ...base, detail: smi.detail };
  const totals = smi.totals;

  const tenants = parseComputeApps(smi.apps);
  const whisperPid = platform === "linux" && deps.whisperPid ? await deps.whisperPid().catch(() => undefined) : undefined;
  const pythons = tenants.filter((t) => isPython(t.processName)).map((t) => t.pid);
  const comfy = pythons.length > 0 && deps.listeningPids ? await deps.listeningPids(COMFYUI_PORT, pythons).catch(() => new Set<number>()) : new Set<number>();
  const imagePid = deps.imagePid?.();
  const label = deps.modelLabel ?? ((tag: string) => tag);
  // why: unprotected is what the next thing in memory asks to leave, read without a second /api/ps.
  const listed = new Set(deps.mayUnload?.() ?? []);
  const mayBeAskedToLeave = (tag: string) => listed.has(tag);

  const { holders, runnerBytes } = holdersOf(tenants, totals.usedBytes, {
    whisper: (t) => t.pid === whisperPid,
    // why: imagePid is the ComfyUI this app runs, on any port; the port finds one started outside it.
    image: (t) => t.pid === imagePid || comfy.has(t.pid),
  });
  const occupants = [...chatOccupants(runnerBytes, models, label, mayBeAskedToLeave), ...holders].toSorted((a, b) => b.bytes - a.bytes);

  return {
    vendor: "nvidia",
    ...(totals.name ? { name: totals.name.replace(/^NVIDIA\s+(GeForce\s+)?/i, "") } : {}),
    totalBytes: totals.totalBytes,
    freeBytes: totals.freeBytes,
    occupants,
    ...base,
  };
}

export function systemdMainPid(unit: string, runner: (cmd: string, args: readonly string[]) => Promise<string> = execText): Promise<number | undefined> {
  return runner("systemctl", ["--user", "show", "-p", "MainPID", "--value", unit]).then((out) => {
    const pid = Number(out.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  });
}

function execText(cmd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, [...args], { timeout: 5000, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

// external: a /proc/net/tcp row is "sl local_address rem_address st tx:rx tr:tm retrnsmt uid timeout inode", and st 0A is LISTEN.
const TCP_ROW = { fields: 10, localAddress: 1, state: 3, inode: 9, listen: "0A" } as const;

export function listeningInodes(procNetTcp: readonly string[], port: number): Set<string> {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set<string>();
  for (const text of procNetTcp) {
    for (const line of text.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < TCP_ROW.fields || f[TCP_ROW.state] !== TCP_ROW.listen) continue;
      const inode = f[TCP_ROW.inode];
      if (f[TCP_ROW.localAddress]?.split(":").pop()?.toUpperCase() === hexPort && inode !== "0") inodes.add(inode ?? "");
    }
  }
  return inodes;
}

export async function procListeningPids(port: number, pids: readonly number[]): Promise<ReadonlySet<number>> {
  const tables = await Promise.all(["/proc/net/tcp", "/proc/net/tcp6"].map((f) => readFile(f, "utf8").catch(() => "")));
  const inodes = listeningInodes(tables, port);
  const hits = new Set<number>();
  if (inodes.size === 0) return hits;
  await Promise.all(
    pids.map(async (pid) => {
      try {
        const fds = await readdir(`/proc/${pid}/fd`);
        for (const fd of fds) {
          const link = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
          const m = /^socket:\[(\d+)\]$/.exec(link);
          if (m?.[1] && inodes.has(m[1])) {
            hits.add(pid);
            return;
          }
        }
      } catch {
        // why: its fds are not this user's to read, so its command line decides.
        const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
        if (/comfy/i.test(cmdline)) hits.add(pid);
      }
    }),
  );
  return hits;
}

export function cached<T>(read: () => Promise<T>, ttlMs: number, now: () => number = Date.now): () => Promise<T> {
  let value: { at: number; v: Promise<T> } | undefined;
  return () => {
    if (value === undefined || now() - value.at >= ttlMs) value = { at: now(), v: read() };
    return value.v;
  };
}
