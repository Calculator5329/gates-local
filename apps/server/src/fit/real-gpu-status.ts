// Run by hand, never by the test runner. It only reads (nvidia-smi queries, /proc, systemctl show,
// GET /api/ps): it loads, unloads, starts and stops nothing.
import { readFileSync } from "node:fs";
import { listLoaded } from "../runtime/models.ts";
import { canonicalTag, modelLabel } from "../runtime/recommended.ts";
import { createOllamaRuntime } from "../runtime/runtime.ts";
import { GPU_POLL_MS } from "./gpu-watch.ts";
import { procListeningPids, readGpuStatus, systemdMainPid, type GpuStatusDeps } from "./gpu-status.ts";

const reads = Math.max(1, Number(process.argv[2] ?? 20) || 20);
const runtime = createOllamaRuntime({ allowInstall: false });
await runtime.discover();
const baseUrl = runtime.baseUrl();

const deps: GpuStatusDeps = {
  whisperPid: () => systemdMainPid("whisper-server.service"),
  listeningPids: procListeningPids,
  modelLabel,
  // why: this script loaded nothing and started no Ollama, so every chat model shows as protected.
  mayUnload: () => [],
  residentModels: async () => (baseUrl ? (await listLoaded(baseUrl)).map((m) => ({ name: canonicalTag(m.name), sizeVramBytes: m.sizeVramBytes })) : []),
};

const gib = (b: number | undefined) => (b === undefined ? "?" : `${(b / 2 ** 30).toFixed(2)} GiB`);
const status = await readGpuStatus(deps);
console.log(`Ollama: ${baseUrl ?? `none (${runtime.status().state})`}`);
console.log("gpu.status:", JSON.stringify(status));
console.log(`${status.vendor} ${status.name ?? ""}  total ${gib(status.totalBytes)}  free ${gib(status.freeBytes)}  RAM available ${gib(status.systemMemoryAvailableBytes)}`);
for (const o of status.occupants) console.log(`  ${o.label.padEnd(30)} ${gib(o.bytes).padStart(10)}  ${o.kind}${o.protected ? "  protected" : ""}`);

// external: /proc/self/stat lists cutime and cstime, the CPU ticks of waited-for children, as fields 16 and 17: 13 and 14 after the comm.
const CUTIME_FIELD = 13;
const CSTIME_FIELD = 14;

function childTicks(): number | undefined {
  try {
    const stat = readFileSync("/proc/self/stat", "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(fields[CUTIME_FIELD]) + Number(fields[CSTIME_FIELD]);
  } catch {
    return undefined;
  }
}
// external: Linux counts these ticks in USER_HZ, which is 100 on every mainstream kernel.
const TICK_MS = 10;

const cpu0 = process.cpuUsage();
const child0 = childTicks();
const t0 = performance.now();
for (let i = 0; i < reads; i++) await readGpuStatus(deps);
const wallMs = performance.now() - t0;
const cpu = process.cpuUsage(cpu0);
const child1 = childTicks();
const selfMs = (cpu.user + cpu.system) / 1000;
const childMs = child0 !== undefined && child1 !== undefined ? (child1 - child0) * TICK_MS : undefined;
const perRead = (selfMs + (childMs ?? 0)) / reads;
console.log(`\nMeasured over ${reads} back-to-back reads (wall ${wallMs.toFixed(0)} ms, ${(wallMs / reads).toFixed(1)} ms each):`);
console.log(`  this process CPU ${selfMs.toFixed(1)} ms, child processes CPU ${childMs === undefined ? "unreadable" : `${childMs} ms (10 ms ticks)`}`);
console.log(`  CPU per read ${perRead.toFixed(1)} ms -> at one read per ${GPU_POLL_MS / 1000} s that is ${((perRead / GPU_POLL_MS) * 100).toFixed(2)}% of one core while a client is connected`);
