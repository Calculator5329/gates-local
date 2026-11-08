// pnpm machine-check: what this machine has and the best models it can run.
// Reads only: nvidia-smi, system memory and free disk. It starts nothing,
// downloads nothing and does not contact Ollama or ComfyUI. The advice is in
// machine-advice.ts; docs/setup/with-claude-code.md says how it is used.
import { statfs } from "node:fs/promises";
import os from "node:os";
import { readMemAvailable } from "../apps/server/src/fit/gpu.ts";
import { advise, formatReport, type MachineReadings, readGpuReading } from "./machine-advice.ts";

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { linux: "Linux", win32: "Windows", darwin: "macOS" };

const [gpu, ramAvailableBytes, disk] = await Promise.all([readGpuReading(), readMemAvailable(), statfs(os.homedir())]);

const machine: MachineReadings = {
  os: `${OS_NAMES[process.platform] ?? process.platform} ${os.release()} ${process.arch}`,
  gpu,
  ramTotalBytes: os.totalmem(),
  ramAvailableBytes,
  diskFreeBytes: disk.bavail * disk.bsize,
  measuredAt: Date.now(),
};

console.log(formatReport(machine, advise(machine)));
