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

function ollamaMib(): number {
  const file = process.env["GATES_LOCAL_FAKE_GPU_STATE"];
  if (!file) return 0;
  try {
    const state: unknown = JSON.parse(readFileSync(file, "utf8"));
    const loaded = typeof state === "object" && state !== null ? (state as { loaded?: unknown }).loaded : undefined;
    if (!Array.isArray(loaded)) return 0;
    return loaded.reduce((sum: number, l: unknown) => {
      const size = typeof l === "object" && l !== null ? (l as { sizeBytes?: unknown }).sizeBytes : 0;
      return sum + (typeof size === "number" ? Math.round(size / MIB) : 0);
    }, 0);
  } catch {
    return 0;
  }
}

const query = process.argv.slice(2).find((a) => a.startsWith("--query-"));
const runner = ollamaMib();
const apps = [...RESIDENT, ...(runner > 0 ? [{ pid: 4410, name: "/usr/local/bin/ollama", mib: runner }] : [])];
const used = apps.reduce((s, a) => s + a.mib, 0) + 210;

const NAME = "NVIDIA GeForce RTX 5070 Ti";
const totals = `${TOTAL}, ${used}, ${Math.max(0, TOTAL - used)}`;

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
