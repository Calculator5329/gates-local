// The image presets: each one a known graph, the exact files it loads, the sizes it runs at and
// the GPU memory a job needs at each size. A preset is offered only when ComfyUI's own file
// list (/object_info) names every file it loads. A checkpoint ComfyUI has that no preset names
// is never offered: its family cannot be told from a file name, and a graph built for another
// family may not run it.
import type { ImageChoice, ImagePreset, Settings } from "@gates-local/contracts";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import { FLUX_CLIP, FLUX_UNET, FLUX_VAE, fluxWorkflow } from "./flux-workflow.ts";
import { CHECKPOINT, IMAGE_ESTIMATED_BYTES, LORA, workflow } from "./workflow.ts";

/** One file a graph loads: the loader node, its input, and the file name ComfyUI must list there. */
export interface PresetFile {
  readonly node: string;
  readonly field: string;
  readonly name: string;
}

export interface Preset {
  readonly id: string;
  readonly name: string;
  /**
   * The composer button's name, beside the family's mark (which says FX or XL already): its first
   * letter is no other preset's, so however narrow the button, two presets never cut to the same text.
   */
  readonly short: string;
  readonly family: string;
  readonly files: readonly PresetFile[];
  /** Every size the graph runs at, first is the default, and the memory a job at it needs. */
  readonly sizes: readonly { readonly width: number; readonly height: number; readonly bytes: number }[];
  /** False while every byte count is an estimate. */
  readonly measured: boolean;
  /** The API graph, given the file names as ComfyUI lists them (in `files` order). */
  graph(prompt: string, seed: number, files: readonly string[], size: { width: number; height: number }): Record<string, unknown>;
}

const GIB = 1024 ** 3;
const checkpoint = { node: "CheckpointLoaderSimple", field: "ckpt_name", name: CHECKPOINT };

// SDXL: 9 GiB at 768x512 is the estimate workflow.ts explains; the portrait turn has the same
// pixel count. 1024x1024 has 2.7 times the pixels: a guess of one more GiB for the larger latent
// and VAE decode, not measured.
const sdxlSizes = [
  { width: 768, height: 512, bytes: IMAGE_ESTIMATED_BYTES },
  { width: 512, height: 768, bytes: IMAGE_ESTIMATED_BYTES },
  { width: 1024, height: 1024, bytes: 10 * GIB },
];

/**
 * The picker's rows, in the order of DEFAULT_ORDER and then the rows only used when picked. The
 * pixel-art row is offered but never a default: its LoRA turns every picture into pixel art.
 */
export const PRESETS: readonly Preset[] = [
  // The lab's rough floor for this model is 7000 MiB (its gen.md: "not benchmarks"); 10 GiB
  // leaves room for the text encoder and the decode. Not measured.
  {
    id: "flux2-klein-4b",
    name: "FLUX.2 Klein 4B",
    short: "Klein 4B",
    family: "flux",
    files: [
      { node: "UNETLoader", field: "unet_name", name: FLUX_UNET },
      { node: "CLIPLoader", field: "clip_name", name: FLUX_CLIP },
      { node: "VAELoader", field: "vae_name", name: FLUX_VAE },
    ],
    sizes: [
      { width: 1024, height: 1024, bytes: 10 * GIB },
      { width: 1024, height: 768, bytes: 10 * GIB },
      { width: 768, height: 1024, bytes: 10 * GIB },
    ],
    measured: false,
    graph: (prompt, seed, [unet, clip, vae], size) => fluxWorkflow(prompt, seed, { unet: unet!, clip: clip!, vae: vae! }, size),
  },
  // Two SDXL rows, because the LoRA turns every picture into pixel art: a person asking the
  // plain row for a photo gets one, and the pixel-art row says what it does.
  {
    id: "sdxl-lightning",
    name: "SDXL Lightning",
    short: "Lightning",
    family: "sdxl",
    files: [checkpoint],
    sizes: sdxlSizes,
    measured: false,
    graph: (prompt, seed, [ckpt], size) => workflow(prompt, seed, ckpt, null, size),
  },
  {
    id: "sdxl-lightning-pixel",
    name: "SDXL Lightning pixel art",
    short: "Pixel art",
    family: "sdxl",
    files: [checkpoint, { node: "LoraLoader", field: "lora_name", name: LORA }],
    sizes: sdxlSizes,
    measured: false,
    graph: (prompt, seed, [ckpt, lora], size) => workflow(prompt, seed, ckpt, lora!, size),
  },
];

/**
 * What an unset Settings choice runs: the first of these whose files ComfyUI lists. A saved
 * choice is never replaced by one of these. Its own rule, not "the first row", so a row added
 * to PRESETS never becomes the default by its place.
 */
export const DEFAULT_ORDER: readonly ImageChoice[] = [
  { preset: "flux2-klein-4b", width: 1024, height: 1024 },
  { preset: "sdxl-lightning", width: 768, height: 512 },
];

/** Absent, or one of DEFAULT_ORDER. */
export const isDefaultChoice = (c: ImageChoice | undefined): boolean =>
  c === undefined || DEFAULT_ORDER.some((d) => d.preset === c.preset && d.width === c.width && d.height === c.height);

/** An unset choice before ComfyUI's file list has been read: the first of DEFAULT_ORDER. */
export const DEFAULT_CHOICE: ImageChoice = DEFAULT_ORDER[0]!;

/** The preset and size a choice names. An unknown preset or a size it does not run at is refused, never swapped. */
export function resolveChoice(choice: ImageChoice): { preset: Preset; size: Preset["sizes"][number] } {
  const preset = PRESETS.find((p) => p.id === choice.preset);
  if (preset === undefined) throw Object.assign(new Error(`There is no image preset ${choice.preset}. Pick an image model in the composer.`), { code: "image-model" });
  const size = preset.sizes.find((s) => s.width === choice.width && s.height === choice.height);
  if (size === undefined) throw Object.assign(new Error(`${preset.name} does not run at ${choice.width} x ${choice.height}. Pick one of its sizes.`), { code: "image-model" });
  return { preset, size };
}

/** For each loader input a preset reads, the file names ComfyUI lists there. */
export type LoaderFiles = Readonly<Record<string, readonly string[]>>;

const LoaderInfo = S.Struct({ input: S.Struct({ required: S.Record(S.String, S.Array(S.Unknown)) }) });
const key = (file: Pick<PresetFile, "node" | "field">) => `${file.node}.${file.field}`;

/** The file lists every preset's loaders need, read from a /object_info answer. */
export function loaderFiles(info: Readonly<Record<string, unknown>>): LoaderFiles {
  const out: Record<string, string[]> = {};
  for (const file of PRESETS.flatMap((p) => p.files)) {
    const loader = S.decodeUnknownOption(LoaderInfo)(info[file.node]);
    const choices = Option.isSome(loader) ? loader.value.input.required[file.field]?.[0] : undefined;
    out[key(file)] = Array.isArray(choices) ? choices.filter((v): v is string => typeof v === "string") : [];
  }
  return out;
}

/** The name ComfyUI lists for this file (it may sit in a subfolder), or undefined when it lists none. */
export function findFile(files: LoaderFiles, file: PresetFile): string | undefined {
  return files[key(file)]?.find((v) => v === file.name || v.replaceAll("\\", "/").endsWith(`/${file.name}`));
}

const row = (p: Preset): ImagePreset => ({ id: p.id, name: p.name, short: p.short, family: p.family, measured: p.measured, sizes: p.sizes.map((s) => ({ ...s })) });

/** The presets whose every file ComfyUI lists, as the picker shows them. */
export function availablePresets(files: LoaderFiles): ImagePreset[] {
  return PRESETS.filter((p) => p.files.every((f) => findFile(files, f) !== undefined)).map(row);
}

/**
 * A refusal's way out: the first setup and size in the picker's list (availablePresets) that needs
 * less than `needBytes` and fits in `roomBytes`, named as the picker names it. Undefined when none
 * would (Klein needs the same at every size; SDXL 768×512 is the smallest need there is).
 */
export function smallerFit(files: LoaderFiles | undefined, needBytes: number, roomBytes: number): string | undefined {
  for (const p of files === undefined ? [] : availablePresets(files)) {
    const size = p.sizes.find((s) => s.bytes < needBytes && s.bytes <= roomBytes);
    if (size !== undefined) return `${p.name} ${size.width}×${size.height}`;
  }
  return undefined;
}

/** A choice as the composer names it. One this build no longer runs (an older preset id) names the default. */
export function describeChoice(choice: ImageChoice, fallback: ImageChoice): { preset: ImagePreset; width: number; height: number } {
  for (const c of [choice, fallback, DEFAULT_CHOICE]) {
    try { const { preset } = resolveChoice(c); return { preset: row(preset), width: c.width, height: c.height }; }
    catch { /* try the next */ }
  }
  return { preset: row(PRESETS[0]!), width: DEFAULT_CHOICE.width, height: DEFAULT_CHOICE.height };
}

/**
 * Tools › Make images: the choice a chat model's image tool runs, or undefined when the tool is
 * off. It needs image generation on too. Unset (every settings file from before the switch) is off.
 */
export function imageToolChoice(settings: Pick<Settings, "imageGen" | "imageTool" | "imageChoice">, files?: LoaderFiles): ImageChoice | undefined {
  return settings.imageGen && settings.imageTool === true ? (settings.imageChoice ?? defaultChoice(files)) : undefined;
}

/**
 * The default for an unset choice: the first of DEFAULT_ORDER ComfyUI has every file for. A
 * default whose files are missing is skipped without a word. When ComfyUI has no DEFAULT_ORDER
 * preset, the first row it has at its first size; when it has none (or its list was never read),
 * DEFAULT_CHOICE.
 */
export function defaultChoice(files: LoaderFiles | undefined): ImageChoice {
  if (files === undefined) return DEFAULT_CHOICE;
  const available = availablePresets(files);
  const listed = DEFAULT_ORDER.find((choice) => available.some((p) => p.id === choice.preset));
  if (listed !== undefined) return listed;
  const first = available[0];
  return first === undefined ? DEFAULT_CHOICE : { preset: first.id, width: first.sizes[0]!.width, height: first.sizes[0]!.height };
}
