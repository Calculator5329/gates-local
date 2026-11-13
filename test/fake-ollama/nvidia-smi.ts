#!/usr/bin/env node
// A fixture nvidia-smi for tests. The server runs it through GATES_LOCAL_NVIDIA_SMI
// with the same query forms it gives the real one:
//   --query-gpu=memory.total,memory.used,memory.free --format=csv,noheader,nounits      (fit)
//   --query-gpu=name,memory.total,memory.used,memory.free --format=csv,noheader,nounits (gpu.status)
//   --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits
// The fixture GPU is 16303 MiB with whisper-server (2150 MiB) and a media-vault
// vision runtime (1822 MiB) resident. When GATES_LOCAL_FAKE_GPU_STATE names the
// fake Ollama's state file, loaded models show up as an ollama runner.
// `--query-gpu=name` answers the card name. Other arguments exit 2.
import { readFileSync } from "node:fs";

const MIB = 1024 * 1024;
const TOTAL = 16_303;
const RESIDENT = [
  { pid: 2101, name: "/usr/local/bin/whisper-server", mib: 2150 },
  { pid: 3388, name: "/opt/media-vault/bin/media-vault-vision", mib: 1822 },
];

/** The runner's MiB (loaded models' GPU parts), another program's MiB and the card's size, from the fake Ollama's state file. */
function fakeState(): { runner: number; other: number; total: number } {
  const file = process.env["GATES_LOCAL_FAKE_GPU_STATE"];
  if (!file) return { runner: 0, other: 0, total: TOTAL };
  try {
    const state: unknown = JSON.parse(readFileSync(file, "utf8"));
    const s = typeof state === "object" && state !== null ? (state as { loaded?: unknown; otherMib?: unknown; totalMib?: unknown }) : {};
    const other = typeof s.otherMib === "number" ? s.otherMib : 0;
    const total = typeof s.totalMib === "number" ? s.totalMib : TOTAL;
    if (!Array.isArray(s.loaded)) return { runner: 0, other, total };
    const runner = s.loaded.reduce((sum: number, l: unknown) => {
      const size = typeof l === "object" && l !== null ? (l as { sizeBytes?: unknown }).sizeBytes : 0;
      return sum + (typeof size === "number" ? Math.round(size / MIB) : 0);
    }, 0);
    return { runner, other, total };
  } catch {
    return { runner: 0, other: 0, total: TOTAL };
  }
}

/** The state file says the computer has no NVIDIA GPU: answer as nvidia-smi does on one. */
function noGpu(): boolean {
  const file = process.env["GATES_LOCAL_FAKE_GPU_STATE"];
  if (!file) return false;
  try {
    const state: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof state === "object" && state !== null && (state as { absent?: unknown }).absent === true;
  } catch {
    return false;
  }
}
if (noGpu()) {
  process.stdout.write("No devices were found\n");
  process.exit(6);
}

const query = process.argv.slice(2).find((a) => a.startsWith("--query-"));
const { runner, other, total } = fakeState();
const apps = [
  ...RESIDENT,
  ...(other > 0 ? [{ pid: 3902, name: "/usr/bin/blender", mib: other }] : []),
  ...(runner > 0 ? [{ pid: 4410, name: "/usr/local/bin/ollama", mib: runner }] : []),
];
const used = apps.reduce((s, a) => s + a.mib, 0) + 210;

const NAME = "NVIDIA GeForce RTX 5070 Ti";
const totals = `${total}, ${used}, ${Math.max(0, total - used)}`;

if (query === "--query-gpu=memory.total,memory.used,memory.free") {
  process.stdout.write(`${totals}\n`);
} else if (query === "--query-gpu=name,memory.total,memory.used,memory.free") {
  process.stdout.write(`${NAME}, ${totals}\n`);
} else if (query === "--query-compute-apps=pid,process_name,used_memory") {
  process.stdout.write(apps.map((a) => `${a.pid}, ${a.name}, ${a.mib}`).join("\n") + "\n");
} else if (query === "--query-gpu=name") {
  process.stdout.write(`${NAME}\n`);
} else {
  process.stderr.write(`fake nvidia-smi: unsupported arguments ${process.argv.slice(2).join(" ")}\n`);
  process.exit(2);
}
