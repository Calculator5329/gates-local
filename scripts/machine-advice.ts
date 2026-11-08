// What `pnpm machine-check` says about a machine, from readings passed in.
// The text pick is the app's own Recommended rule (the catalog for a machine
// with nothing installed yet), imported so the two cannot disagree. Reads only.
import type { CatalogEntry } from "@gates-local/contracts";
import { estimateBeforeDownload } from "../apps/server/src/fit/fit.ts";
import { defaultNvidiaSmi, readGpu } from "../apps/server/src/fit/gpu.ts";
import type { NvidiaSmiRunner } from "../apps/server/src/fit/types.ts";
import { CHECKPOINT, IMAGE_ESTIMATED_BYTES, LORA } from "../apps/server/src/image/workflow.ts";
import { markRecommended } from "../apps/server/src/runtime/catalog.ts";
import { CURATED_MODELS } from "../apps/server/src/runtime/recommended.ts";
import { defaultSettings } from "../apps/server/src/settings/store.ts";

/** ByteDance/SDXL-Lightning's file size, from docs/research/setup-tiers-2026-11.md. */
const CHECKPOINT_DOWNLOAD_BYTES = 6_938_000_000;

const GPU_NAME_ARGS = ["--query-gpu=name", "--format=csv,noheader"] as const;

export type GpuReading = { kind: "nvidia"; name?: string; totalBytes: number; freeBytes: number } | { kind: "none" } | { kind: "unreadable"; reason: string };

export interface MachineReadings {
  os: string;
  gpu: GpuReading;
  ramTotalBytes: number;
  ramAvailableBytes: number;
  diskFreeBytes: number;
  measuredAt: number;
}

export type TextAdvice =
  | { use: true; model: string; label: string; purpose: string; downloadBytes: number; verdict: "fits" | "spills"; needBytes: number; alsoRecommended: string[] }
  | { use: false; why: string };

export type ImageAdvice = { use: true; checkpoint: string; lora: string; note?: string } | { use: false; why: string };

export interface Advice {
  numCtx: number;
  text: TextAdvice;
  image: ImageAdvice;
  warnings: string[];
}

/** Memory and disk as a card or drive is sold: 16376 MiB reads 16.0 GB. */
const memory = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
/** Downloads in decimal GB, as Ollama and download pages show them. */
const download = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

function catalog(machine: MachineReadings, numCtx: number): CatalogEntry[] {
  const freeVramBytes = machine.gpu.kind === "nvidia" ? machine.gpu.freeBytes : 0;
  const entries = CURATED_MODELS.filter((c) => c.pullable).map((c) => ({
    name: c.name,
    label: c.label,
    purpose: c.purpose,
    downloadBytes: c.downloadBytes,
    installed: false,
    recommended: false,
    fit: estimateBeforeDownload({ model: c.name, numCtx, downloadBytes: c.downloadBytes, freeVramBytes, memAvailableBytes: machine.ramAvailableBytes, measuredAt: machine.measuredAt }),
  }));
  return markRecommended(entries, numCtx);
}

function textAdvice(machine: MachineReadings, entries: readonly CatalogEntry[]): TextAdvice {
  const recommended = entries.filter((e) => e.recommended);
  const best = recommended[0];
  if (best?.fit === undefined || best.fit.verdict === "refuse") {
    const lightest = entries.toSorted((a, b) => (a.fit?.needVramBytes ?? 0) - (b.fit?.needVramBytes ?? 0))[0];
    const gpu = machine.gpu.kind === "nvidia" ? `${memory(machine.gpu.freeBytes)} of GPU memory free and ` : "";
    return { use: false, why: `The lightest model, ${lightest?.name}, needs about ${memory(lightest?.fit?.needVramBytes ?? 0)}. This machine has ${gpu}${memory(machine.ramAvailableBytes)} of system memory available.` };
  }
  return {
    use: true,
    model: best.name,
    label: best.label,
    purpose: best.purpose,
    downloadBytes: best.downloadBytes,
    verdict: best.fit.verdict,
    needBytes: best.fit.needVramBytes,
    alsoRecommended: recommended.slice(1).map((e) => e.name),
  };
}

function imageAdvice(gpu: GpuReading): ImageAdvice {
  const need = memory(IMAGE_ESTIMATED_BYTES);
  if (gpu.kind === "none") {
    return { use: false, why: `Found no GPU the app can read (it reads GPU memory with nvidia-smi, so NVIDIA only). On the CPU each image is slow, and its time through ComfyUI has not been measured.` };
  }
  if (gpu.kind === "unreadable") return { use: false, why: `The GPU could not be read: ${gpu.reason}.` };
  if (gpu.totalBytes < IMAGE_ESTIMATED_BYTES) return { use: false, why: `This GPU has ${memory(gpu.totalBytes)} of memory and an image job wants about ${need}.` };
  const base = { use: true as const, checkpoint: CHECKPOINT, lora: LORA };
  if (gpu.freeBytes >= IMAGE_ESTIMATED_BYTES) return base;
  return { ...base, note: `Only ${memory(gpu.freeBytes)} free on the GPU right now and an image job wants about ${need}. Other programs hold the rest.` };
}

export function advise(machine: MachineReadings): Advice {
  const numCtx = defaultSettings("system").defaultNumCtx;
  const text = textAdvice(machine, catalog(machine, numCtx));
  const image = imageAdvice(machine.gpu);
  const warnings: string[] = [];
  if (machine.gpu.kind === "unreadable") warnings.push(`${machine.gpu.reason}. The app will not start a chat until this is fixed, so the text pick below plans as if there were no GPU.`);
  const total = (text.use ? text.downloadBytes : 0) + (image.use ? CHECKPOINT_DOWNLOAD_BYTES : 0);
  if (total > machine.diskFreeBytes) warnings.push(`The downloads recommended here total ${download(total)}, before ComfyUI itself, and the disk has ${memory(machine.diskFreeBytes)} free.`);
  return { numCtx, text, image, warnings };
}

/** What the app itself would see: no nvidia-smi is no GPU; an nvidia-smi that fails is a fault to report. */
export async function readGpuReading(run: NvidiaSmiRunner = defaultNvidiaSmi): Promise<GpuReading> {
  try {
    const gpu = await readGpu(run);
    if (gpu.gpuCount === 0) return { kind: "none" };
    const name = await run(GPU_NAME_ARGS).then((t) => t.split(/\r?\n/)[0]?.trim(), () => undefined);
    return { kind: "nvidia", ...(name ? { name } : {}), totalBytes: gpu.totalBytes, freeBytes: gpu.freeBytes };
  } catch (e) {
    return { kind: "unreadable", reason: (e as Error).message };
  }
}

function gpuLine(gpu: GpuReading): string {
  if (gpu.kind === "none") return "None the app can read (it uses nvidia-smi, so NVIDIA only)";
  if (gpu.kind === "unreadable") return `Could not be read: ${gpu.reason}`;
  return `${gpu.name ?? "NVIDIA GPU"}, ${memory(gpu.totalBytes)} total, ${memory(gpu.freeBytes)} free right now`;
}

function textLines({ text, numCtx }: Advice): string[] {
  if (!text.use) return [`No model to recommend. ${text.why}`];
  const where = text.verdict === "fits" ? "Runs on the GPU" : "Uses system memory, slower";
  return [
    `${text.model} (${text.label}: ${text.purpose})`,
    `${download(text.downloadBytes)} download. ${where} at ${numCtx / 1024}k context, needs about ${memory(text.needBytes)}.`,
    ...(text.alsoRecommended.length > 0 ? [`Also recommended here: ${text.alsoRecommended.join(", ")}`] : []),
  ];
}

function imageLines({ image }: Advice): string[] {
  if (!image.use) return [`Skip image generation. ${image.why}`];
  return [
    `ComfyUI with checkpoint ${image.checkpoint} (${download(CHECKPOINT_DOWNLOAD_BYTES)} download)`,
    `and LoRA ${image.lora}. The app installs neither.`,
    ...(image.note === undefined ? [] : [image.note]),
  ];
}

const row = (label: string, lines: readonly string[]) => lines.map((line, i) => `${(i === 0 ? label : "").padEnd(12)}${line}`);

export function formatReport(machine: MachineReadings, advice: Advice): string {
  return [
    "Gates Local machine check. This only reads: nothing was downloaded, installed or started.",
    "",
    ...row("OS", [machine.os]),
    ...row("GPU", [gpuLine(machine.gpu)]),
    ...row("RAM", [`${memory(machine.ramTotalBytes)} total, ${memory(machine.ramAvailableBytes)} available`]),
    ...row("Free disk", [`${memory(machine.diskFreeBytes)} on the drive with your home folder`]),
    "",
    ...row("Text", textLines(advice)),
    ...row("Image", imageLines(advice)),
    "",
    ...advice.warnings.map((w) => `Warning: ${w}`),
    ...(advice.warnings.length > 0 ? [""] : []),
    "The text pick is the app's Recommended rule, from the memory free right now.",
  ].join("\n");
}
