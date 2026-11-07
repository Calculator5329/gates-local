// gpu.status: what holds GPU memory now, named for people. Read-only: this
// module never signals, stops or reconfigures any process it lists.
//
// Occupants come from nvidia-smi's compute apps. Whisper (by name, or the
// MainPID of whisper-server.service on Linux) and other apps are protected.
// Ollama runners carry the model names from /api/ps; a ComfyUI python that
// listens on 8188 is "image"; used memory no process accounts for is
// "unknown". No NVIDIA GPU (or no nvidia-smi, as on Windows here) is vendor
// "none"; an nvidia-smi that fails is "unreadable" with the reason.
import { execFile } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import os from "node:os";
import type { GpuOccupant, GpuStatus } from "@gates-local/contracts";
import { MIB } from "./constants.ts";
import { defaultNvidiaSmi, GPU_APPS_ARGS, parseComputeApps, parseMemAvailable } from "./gpu.ts";
import type { MeminfoReader, NvidiaSmiRunner } from "./types.ts";

export const GPU_STATUS_ARGS = ["--query-gpu=name,memory.total,memory.used,memory.free", "--format=csv,noheader,nounits"] as const;

/** ComfyUI's default port: a python GPU process listening here is the image runtime. */
export const COMFYUI_PORT = 8188;

/** Below this, memory nvidia-smi cannot attribute is noise, not an occupant. */
const UNKNOWN_MIN_BYTES = 64 * MIB;

export interface ResidentModel {
  name: string;
  sizeVramBytes: number;
}

export interface GpuStatusDeps {
  platform?: NodeJS.Platform;
  runNvidiaSmi?: NvidiaSmiRunner;
  /** Linux: the text of /proc/meminfo. */
  readMeminfo?: MeminfoReader;
  /** Elsewhere: os.freemem(). */
  freemem?: () => number;
  /** Linux: MainPID of whisper-server.service, undefined when it is not running. */
  whisperPid?: () => Promise<number | undefined>;
  /** /api/ps of the Ollama in use; [] when there is none. */
  residentModels?: () => Promise<readonly ResidentModel[]>;
  /** Which of these pids listen on the TCP port. */
  listeningPids?: (port: number, pids: readonly number[]) => Promise<ReadonlySet<number>>;
  /** Friendly model name for a tag ("Qwen 3.5 9B"). */
  modelLabel?: (tag: string) => string;
  /** Models this app loaded; only those are unprotected chat-model occupants. */
  appLoaded?: () => readonly string[];
  now?: () => number;
}

const KNOWN_APPS: readonly [RegExp, string][] = [
  [/media-vault/i, "Media Vault vision"],
  [/kwin/i, "Desktop (KWin)"],
  [/gnome-shell|mutter/i, "Desktop (GNOME)"],
  [/Xorg|Xwayland/i, "Desktop (X server)"],
];

/** Last path segment of a Linux or Windows command, without ".exe". */
export function processBasename(processName: string): string {
  const command = processName.trim().split(/\s+--?\w/)[0]?.trim() ?? processName;
  const base = command.split(/[\\/]/).pop() || command;
  return base.replace(/\.exe$/i, "");
}

function otherAppLabel(processName: string): string {
  for (const [pattern, label] of KNOWN_APPS) if (pattern.test(processName)) return label;
  return processBasename(processName);
}

const isPython = (processName: string) => /python|comfy/i.test(processBasename(processName));

function parseStatusTotals(text: string): { name: string; totalBytes: number; usedBytes: number; freeBytes: number } | undefined {
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 4) continue;
    const [total, used, free] = parts.slice(-3).map((p) => (/^\d+(\.\d+)?$/.test(p) ? Math.round(Number(p) * MIB) : undefined));
    if (total === undefined || used === undefined || free === undefined) continue;
    return { name: parts.slice(0, -3).join(","), totalBytes: total, usedBytes: used, freeBytes: free };
  }
  return undefined;
}

type SmiRead = { kind: "ok"; totals: string; apps: string } | { kind: "none"; detail: string } | { kind: "unreadable"; detail: string };

async function readSmi(run: NvidiaSmiRunner): Promise<SmiRead> {
  try {
    const [totals, apps] = await Promise.all([run(GPU_STATUS_ARGS), run(GPU_APPS_ARGS)]);
    return { kind: "ok", totals, apps };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string };
    const text = `${err.message ?? ""} ${err.stdout ?? ""}`;
    if (err.code === "ENOENT") return { kind: "none", detail: "No NVIDIA GPU found (nvidia-smi is not installed); models run on the CPU and system memory." };
    if (/No devices were found/i.test(text)) return { kind: "none", detail: "nvidia-smi found no NVIDIA GPU; models run on the CPU and system memory." };
    return { kind: "unreadable", detail: `nvidia-smi failed: ${(err.message ?? String(e)).split("\n")[0]}` };
  }
}

async function systemMemoryAvailable(deps: GpuStatusDeps, platform: NodeJS.Platform): Promise<number> {
  if (platform === "linux") {
    try {
      return parseMemAvailable(await (deps.readMeminfo ?? (() => readFile("/proc/meminfo", "utf8")))());
    } catch {
      // fall through to the portable reading
    }
  }
  return (deps.freemem ?? os.freemem)();
}

/** Splits the runners' measured bytes across the resident models in proportion to their size_vram. */
function chatOccupants(runnerBytes: number, models: readonly ResidentModel[], label: (tag: string) => string, appLoaded: ReadonlySet<string>): GpuOccupant[] {
  if (models.length === 0) return runnerBytes > 0 ? [{ label: "Ollama", bytes: runnerBytes, kind: "chat-model", protected: true }] : [];
  const vramSum = models.reduce((s, m) => s + m.sizeVramBytes, 0);
  const total = Math.max(runnerBytes, vramSum);
  return models.map((m) => ({
    label: label(m.name),
    bytes: Math.round(vramSum > 0 ? (total * m.sizeVramBytes) / vramSum : total / models.length),
    kind: "chat-model" as const,
    protected: !appLoaded.has(m.name),
  }));
}

export async function readGpuStatus(deps: GpuStatusDeps = {}): Promise<GpuStatus> {
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const run = deps.runNvidiaSmi ?? defaultNvidiaSmi;
  const [smi, memAvail, models] = await Promise.all([
    readSmi(run),
    systemMemoryAvailable(deps, platform),
    (deps.residentModels ?? (async () => []))().catch(() => [] as readonly ResidentModel[]),
  ]);
  const base = { systemMemoryAvailableBytes: Math.max(0, Math.round(memAvail)), measuredAt: now() };
  if (smi.kind !== "ok") return { vendor: smi.kind, occupants: [], ...base, detail: smi.detail };
  const totals = parseStatusTotals(smi.totals);
  if (totals === undefined) return { vendor: "unreadable", occupants: [], ...base, detail: `nvidia-smi printed no GPU memory line: ${JSON.stringify(smi.totals.slice(0, 120))}` };

  const tenants = parseComputeApps(smi.apps);
  const whisperPid = platform === "linux" && deps.whisperPid ? await deps.whisperPid().catch(() => undefined) : undefined;
  const pythons = tenants.filter((t) => isPython(t.processName)).map((t) => t.pid);
  const comfy = pythons.length > 0 && deps.listeningPids ? await deps.listeningPids(COMFYUI_PORT, pythons).catch(() => new Set<number>()) : new Set<number>();
  const label = deps.modelLabel ?? ((tag: string) => tag);
  const appLoaded = new Set(deps.appLoaded?.() ?? []);

  let runnerBytes = 0;
  let accounted = 0;
  const grouped = new Map<string, GpuOccupant>();
  const add = (o: GpuOccupant) => {
    const key = `${o.kind}\0${o.label}`;
    const prev = grouped.get(key);
    grouped.set(key, prev ? { ...prev, bytes: prev.bytes + o.bytes } : o);
  };
  for (const t of tenants) {
    const bytes = t.usedBytes ?? 0;
    accounted += bytes;
    if (t.role === "whisper" || t.pid === whisperPid) add({ label: "Whisper", bytes, kind: "whisper", protected: true });
    else if (t.role === "ollama") runnerBytes += bytes;
    else if (comfy.has(t.pid)) add({ label: "ComfyUI", bytes, kind: "image", protected: false });
    else add({ label: otherAppLabel(t.processName), bytes, kind: "other-app", protected: true });
  }
  const occupants = [...chatOccupants(runnerBytes, models, label, appLoaded), ...grouped.values()];
  const unknown = totals.usedBytes - accounted;
  if (unknown >= UNKNOWN_MIN_BYTES) occupants.push({ label: "Not attributed to a process", bytes: unknown, kind: "unknown", protected: true });
  occupants.sort((a, b) => b.bytes - a.bytes);

  return {
    vendor: "nvidia",
    ...(totals.name ? { name: totals.name.replace(/^NVIDIA\s+(GeForce\s+)?/i, "") } : {}),
    totalBytes: totals.totalBytes,
    freeBytes: totals.freeBytes,
    occupants,
    ...base,
  };
}

// ------------------------------------------------------------ Linux readers

/** `systemctl --user show -p MainPID --value whisper-server.service`; read-only. */
export function systemdMainPid(unit: string, runner: (cmd: string, args: readonly string[]) => Promise<string> = execText): Promise<number | undefined> {
  return runner("systemctl", ["--user", "show", "-p", "MainPID", "--value", unit]).then((out) => {
    const pid = Number(out.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  });
}

function execText(cmd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, [...args], { timeout: 5000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

/** Socket inodes in LISTEN state on the port, from /proc/net/tcp and tcp6 text. */
export function listeningInodes(procNetTcp: readonly string[], port: number): Set<string> {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set<string>();
  for (const text of procNetTcp) {
    for (const line of text.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      // sl local_address rem_address st tx:rx tr:tm retrnsmt uid timeout inode
      if (f.length < 10 || f[3] !== "0A") continue;
      if (f[1]?.split(":").pop()?.toUpperCase() === hexPort && f[9] !== "0") inodes.add(f[9] ?? "");
    }
  }
  return inodes;
}

/**
 * Linux: which pids hold a listening socket on the port. A process whose fds
 * this user cannot read counts when its command line names ComfyUI.
 */
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
        const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
        if (/comfy/i.test(cmdline)) hits.add(pid);
      }
    }),
  );
  return hits;
}

/** Caches a slow read (a systemctl spawn) for ttlMs. */
export function cached<T>(read: () => Promise<T>, ttlMs: number, now: () => number = Date.now): () => Promise<T> {
  let value: { at: number; v: Promise<T> } | undefined;
  return () => {
    if (value === undefined || now() - value.at >= ttlMs) value = { at: now(), v: read() };
    return value.v;
  };
}
