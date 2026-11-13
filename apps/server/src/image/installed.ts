// The model files already in ComfyUI's folders, read from their safetensors headers (never the
// weights): which family each is for, so a checkpoint becomes a setup and a LoRA a style on its
// family's setup. Only for a ComfyUI on this machine, in the folders its /internal/folder_paths
// names. The family comes from the header's metadata (`modelspec.architecture`,
// `ss_base_model_version`), else from its tensor names and shapes:
// - SDXL: a checkpoint's `conditioner.embedders.1`; a LoRA's `lora_te2_` or `lora_unet_input_blocks`;
// - SD 1.5: a checkpoint's `cond_stage_model.transformer`; a LoRA's `lora_unet_down_blocks` or `lora_te_text_model` alone;
// - FLUX.2 Klein 4B: Flux blocks 3072 wide, no more than its 5 double and 20 single blocks; more is
//   FLUX.1 (19 and 38). A Fill model's wider image input (more than 128 channels) is left out.
// A file it cannot place is left out, as are inpainting (Fill) and audio models: an SD or SDXL
// checkpoint whose first UNet layer takes other than 4 channels (an inpainting one takes 9) too.
// Only a plain file is read (a pipe would hang the read), and only by a name inside its folder;
// a linked file or folder in there is followed wherever it points, as ComfyUI does.
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ApiGraph } from "./convert.ts";
import { GROUPS, type KnownWorkflow, type ModelSource } from "./presets.ts";
import klein from "./setups/flux2-klein-4b.json" with { type: "json" };
import checkpoint from "./setups/sdxl-checkpoint.json" with { type: "json" };
import fileSources from "./setups/files.json" with { type: "json" };

/** What a header says: its metadata, and each tensor's name and shape. */
export interface Header { readonly metadata: Readonly<Record<string, string>>; readonly shapes: Readonly<Record<string, readonly number[]>> }

/** Families the app knows by name; a LoRA or checkpoint for one it has no setup for is listed with that reason. */
export type Family = "sdxl" | "sd15" | "flux2-klein-4b" | "flux1" | "flux1-kontext" | "zimage" | "qwen-image";
export const FAMILY_NAMES: Readonly<Record<Family, string>> = {
  sdxl: "SDXL", sd15: "Stable Diffusion 1.5", "flux2-klein-4b": "FLUX.2 Klein 4B", flux1: "FLUX.1", "flux1-kontext": "FLUX.1 Kontext", zimage: "Z-Image Turbo", "qwen-image": "Qwen-Image",
};

/** An installed file as kept: its kind (ComfyUI folder), name as ComfyUI lists it, size, family and whether it is a few-step model. */
export interface InstalledFile { readonly kind: "checkpoints" | "loras"; readonly name: string; readonly bytes: number; readonly family: Family; readonly fewStep?: boolean }

const MAX_HEADER = 8 * 1024 * 1024;

/** The header of a safetensors file, or undefined when it is not one (or its header is implausibly large). */
export async function readHeader(file: string): Promise<Header | undefined> {
  const handle = await open(file, "r");
  try {
    const head = Buffer.alloc(8);
    if ((await handle.read(head, 0, 8, 0)).bytesRead < 8) return undefined;
    const length = head.readBigUInt64LE(0);
    if (length < 2n || length > BigInt(MAX_HEADER)) return undefined;
    const body = Buffer.alloc(Number(length));
    if ((await handle.read(body, 0, body.length, 8)).bytesRead < body.length) return undefined;
    const json: unknown = JSON.parse(body.toString("utf8"));
    if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined;
    const metadata: Record<string, string> = {}, shapes: Record<string, number[]> = {};
    for (const [key, value] of Object.entries(json)) {
      if (key === "__metadata__") { for (const [k, v] of Object.entries(value ?? {})) if (typeof v === "string") metadata[k] = v; continue; }
      const shape = (value as { shape?: unknown } | null)?.shape;
      if (Array.isArray(shape) && shape.every((n) => typeof n === "number")) shapes[key] = shape;
    }
    return { metadata, shapes };
  } catch { return undefined; }
  finally { await handle.close(); }
}

const byArchitecture = (arch: string): Family | undefined => {
  const a = arch.toLowerCase();
  if (/inpaint|fill|audio/.test(a)) return undefined;
  if (/flux[.-]?2[.-]?klein[.-]?4b/.test(a)) return "flux2-klein-4b";
  if (/kontext/.test(a)) return "flux1-kontext";
  if (/flux[.-]?1/.test(a)) return "flux1";
  if (/stable-diffusion-xl|sdxl/.test(a)) return "sdxl";
  if (/stable-diffusion-v1|sd_?v?1/.test(a)) return "sd15";
  if (/z-?image/.test(a)) return "zimage";
  if (/qwen-?image/.test(a)) return "qwen-image";
  return undefined;
};

const maxIndex = (keys: readonly string[], pattern: RegExp) => Math.max(-1, ...keys.map((k) => Number(pattern.exec(k)?.[1] ?? -1)));

/** The family a header is for, or undefined when it cannot say. */
export function familyOf(header: Header, kind: InstalledFile["kind"]): Family | undefined {
  const m = header.metadata;
  for (const v of [m["modelspec.architecture"], m["ss_base_model_version"]]) {
    if (v === undefined) continue;
    if (/inpaint|fill|audio/i.test(v)) return undefined;
    const family = byArchitecture(v);
    if (family !== undefined) return family;
  }
  const keys = Object.keys(header.shapes);
  const has = (re: RegExp) => keys.some((k) => re.test(k));
  const convIn = header.shapes["model.diffusion_model.input_blocks.0.0.weight"]?.[1];
  if (kind === "checkpoints" && convIn !== undefined && convIn !== 4) return undefined; // inpainting: 9 channels in
  if (has(/^conditioner\.(embedders|conditioners)\./) && !has(/conditioner\.embedders\.1\./)) return undefined; // audio and others
  if (has(/conditioner\.embedders\.1\./) || has(/^lora_te2_/) || has(/^lora_unet_(input_blocks|output_blocks|middle_block)_/)) return "sdxl";
  if (has(/^cond_stage_model\.transformer\./) || has(/^lora_unet_down_blocks_/) || (has(/^lora_te_text_model/) && !has(/^lora_te2_/))) return "sd15";
  if (has(/double_blocks[._]\d/) || has(/single_blocks[._]\d/)) {
    const imgIn = Object.entries(header.shapes).find(([k]) => /(^|\.)img_in\.weight$/.test(k))?.[1];
    if (kind === "checkpoints" && imgIn !== undefined && imgIn[1] !== undefined && imgIn[1] > 128) return undefined; // Fill: extra input channels
    const double = maxIndex(keys, /double_blocks[._](\d+)/), single = maxIndex(keys, /single_blocks[._](\d+)/);
    const wide = Object.entries(header.shapes).some(([k, s]) => /double_blocks[._]\d+[._]img_attn[._]qkv/.test(k) && s.includes(3072));
    if (!wide) return undefined;
    return double <= 4 && single <= 19 ? "flux2-klein-4b" : "flux1";
  }
  return undefined;
}

/** A few-step distillation of a person's own checkpoint, by the words its metadata or name uses for one. */
export const fewStep = (name: string, header: Header) => /lightning|turbo|hyper|lcm/i.test([name, ...Object.values(header.metadata).filter((v) => v.length < 400)].join(" "));

/**
 * The checkpoints and LoRAs ComfyUI lists, placed by their headers. `folders` is ComfyUI's own
 * /internal/folder_paths answer; a name is only read inside one of its kind's folders.
 */
export async function readInstalled(folders: Readonly<Record<string, readonly string[]>>, lists: Readonly<Record<string, readonly string[]>>): Promise<InstalledFile[]> {
  const out: InstalledFile[] = [];
  for (const kind of ["checkpoints", "loras"] as const) {
    const names = [...new Set(Object.entries(lists).filter(([key]) => key === (kind === "checkpoints" ? "CheckpointLoaderSimple.ckpt_name" : "LoraLoader.lora_name")).flatMap(([, v]) => v))];
    for (const name of names) {
      if (!name.toLowerCase().endsWith(".safetensors")) continue;
      for (const folder of folders[kind] ?? []) {
        const file = path.resolve(folder, name);
        if (!file.startsWith(path.resolve(folder) + path.sep)) continue;
        let bytes: number, real: string;
        try {
          // a link out of the folder is read: ComfyUI lists and runs it, as people keep models on another disk
          real = await realpath(file);
          const s = await stat(real);
          if (!s.isFile()) continue; // a pipe or a folder: opening a pipe would wait for ever
          bytes = s.size;
        } catch { continue; }
        const header = await readHeader(real).catch(() => undefined);
        const family = header && familyOf(header, kind);
        if (header && family) out.push({ kind, name, bytes, family, ...fewStep(name, header) ? { fewStep: true } : {} });
        break;
      }
    }
  }
  return out;
}

/** Whether a ComfyUI address is this machine: only then are its folders this machine's folders. */
export function isLocalComfy(baseUrl: string): boolean {
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseUrl).hostname); }
  catch { return false; }
}

/**
 * The installed files as setups (installedWorkflows), for a ComfyUI on this machine: its folders from
 * GET /internal/folder_paths, each kind's first entry a list of paths. Undefined when the ComfyUI is
 * elsewhere or the route fails, so the caller keeps what it had.
 */
export async function readInstalledSetups(get: (route: string) => Promise<unknown>, baseUrl: string, files: Readonly<Record<string, readonly string[]>>): Promise<KnownWorkflow[] | undefined> {
  if (!isLocalComfy(baseUrl)) return undefined;
  let answer: unknown;
  try { answer = await get("/internal/folder_paths"); } catch { return undefined; }
  const folders = comfyFolders(answer);
  return folders && installedWorkflows(await readInstalled(folders, files));
}

/** ComfyUI's /internal/folder_paths answer: each kind's absolute folders, first is where it saves. */
export function comfyFolders(answer: unknown): Record<string, string[]> | undefined {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return undefined;
  const folders: Record<string, string[]> = {};
  for (const [kind, value] of Object.entries(answer)) if (Array.isArray(value)) folders[kind] = value.filter((p): p is string => typeof p === "string" && path.isAbsolute(p));
  return folders;
}

const clone = (graph: unknown): ApiGraph => structuredClone(graph) as ApiGraph;
const base = (name: string) => name.replaceAll("\\", "/").split("/").at(-1)!;
const title = (name: string) => base(name).replace(/\.safetensors$/i, "");
/** The picker's family mark for each family. */
const MARK: Readonly<Record<Family, string>> = { sdxl: "sdxl", sd15: "sd15", "flux2-klein-4b": "flux", flux1: "flux", "flux1-kontext": "flux", zimage: "zimage", "qwen-image": "qwen" };
const APP_SOURCES: Readonly<Record<string, ModelSource>> = fileSources;

/**
 * A checkpoint's graph: setups/sdxl-checkpoint.json with its file, at the family's plain settings
 * (SDXL 28 steps, cfg 5, dpmpp_2m karras at 1024 x 1024; SD 1.5 the same at 512 x 512, cfg 7), or
 * the graph's own 4 steps at cfg 1, euler on sgm_uniform, when the file says it is a few-step model.
 */
function checkpointGraph(file: InstalledFile): ApiGraph {
  const graph = clone(checkpoint);
  graph["1"]!.inputs["ckpt_name"] = file.name;
  const side = file.family === "sd15" ? 512 : 1024;
  Object.assign(graph["5"]!.inputs, { width: side, height: side });
  if (!file.fewStep) Object.assign(graph["6"]!.inputs, { steps: 28, cfg: file.family === "sd15" ? 7 : 5, sampler_name: "dpmpp_2m", scheduler: "karras" });
  graph["8"]!.inputs["filename_prefix"] = `gates-local/${file.family}`;
  return graph;
}

/** A LoRA on a graph whose model and clip come from node 1 (checkpoint), at 0.8. */
function withLora(graph: ApiGraph, lora: string): ApiGraph {
  graph["2"] = { class_type: "LoraLoader", inputs: { lora_name: lora, strength_model: 0.8, strength_clip: 0.8, model: ["1", 0], clip: ["1", 1] } };
  graph["3"]!.inputs["clip"] = ["2", 1];
  graph["4"]!.inputs["clip"] = ["2", 1];
  graph["6"]!.inputs["model"] = ["2", 0];
  return graph;
}

/** A LoRA on the app's Klein 4B setup: model only (its text encoder is not CLIP), at 0.8. */
function kleinLora(lora: string): ApiGraph {
  const graph = clone(klein);
  graph["14"] = { class_type: "LoraLoaderModelOnly", inputs: { lora_name: lora, strength_model: 0.8, model: ["1", 0] } };
  graph["6"]!.inputs["model"] = ["14", 0];
  return graph;
}

/**
 * The installed files as setups, in the group "Your models": a checkpoint of SDXL or SD 1.5 with its
 * family's plain settings; a LoRA as a style on its family's base (the app's Klein 4B setup, which
 * needs its files when they are missing, or the first installed SDXL or SD 1.5 checkpoint, a plain
 * one before a few-step one); a file of a family Image mode has no setup for, refused with that reason.
 */
export function installedWorkflows(files: readonly InstalledFile[]): KnownWorkflow[] {
  const out: KnownWorkflow[] = [];
  const checkpoints = files.filter((f) => f.kind === "checkpoints").toSorted((a, b) => Number(a.fewStep ?? false) - Number(b.fewStep ?? false));
  const baseOf = (family: Family) => checkpoints.find((f) => f.family === family);
  for (const file of files) {
    const own: Record<string, ModelSource> = { [file.name]: { directory: file.kind, bytes: file.bytes } };
    const kept = { id: `file:${file.kind}/${file.name}`, group: GROUPS.installed, family: MARK[file.family] };
    const familyName = FAMILY_NAMES[file.family];
    if (file.kind === "checkpoints") {
      if (file.family === "sdxl" || file.family === "sd15") out.push({ ...kept, name: title(file.name), graph: checkpointGraph(file), sources: own });
      else out.push({ ...kept, name: title(file.name), why: `A ${familyName} checkpoint; Image mode has no ${familyName} setup to run it in.` });
      continue;
    }
    const name = `${title(file.name)} style`;
    const onCheckpoint = file.family === "sdxl" || file.family === "sd15";
    const under = onCheckpoint ? baseOf(file.family) : undefined;
    if (file.family === "flux2-klein-4b") out.push({ ...kept, name, graph: kleinLora(file.name), sources: { ...APP_SOURCES, ...own } });
    else if (under !== undefined) out.push({ ...kept, name, graph: withLora(checkpointGraph(under), file.name), sources: { [under.name]: { directory: "checkpoints", bytes: under.bytes }, ...own } });
    else out.push({ ...kept, name, why: `A ${familyName} LoRA; it needs a ${familyName} model, and ${onCheckpoint ? "none is installed" : `Image mode has no ${familyName} setup that takes a LoRA`}.` });
  }
  return out;
}
