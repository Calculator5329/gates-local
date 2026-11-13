// The image setups: each one a ComfyUI workflow file, plus the name the picker shows, the sizes it
// is offered at and the GPU memory a job needs at each. What Image mode fills in (prompt, size,
// seed, output) is found in the graph by its shape (controls.ts), and the files it loads are read
// from the graph too: every input whose value is a model file name. A setup is ready when
// ComfyUI's /object_info lists every node class it uses and names every file it loads; one that
// is not is still listed, with the reason.
//
// The app's own setups are the API-format files in setups/ (origin in setups/README.md), one or
// more per theme; a theme's prompt wrapping is written around the person's words. The setups
// ComfyUI has (its templates and the person's saved workflows, sources.ts) come after them, and
// then the model files already in its folders (installed.ts).
import type { ImageChoice, ImagePreset, Settings } from "@gates-local/contracts";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import { applyControls, findControls } from "./controls.ts";
import { convertWorkflow, WorkflowRefusal, type ApiGraph, type ObjectInfo } from "./convert.ts";
import { huggingFace } from "./download.ts";
import klein from "./setups/flux2-klein-4b.json" with { type: "json" };
import kleinCompact from "./setups/flux2-klein-4b-compact.json" with { type: "json" };
import kleinPixel from "./setups/flux2-klein-4b-pixel.json" with { type: "json" };
import moss from "./setups/moss-image.json" with { type: "json" };
import zImage from "./setups/z-image-turbo-int8.json" with { type: "json" };
import fileSources from "./setups/files.json" with { type: "json" };

export interface Preset {
  readonly id: string;
  readonly name: string;
  /**
   * The composer button's name, beside the family's mark (which says FX or ZI already): its first
   * letter is no other preset's, so however narrow the button, two presets never cut to the same text.
   */
  readonly short: string;
  readonly family: string;
  /** The workflow, in either of ComfyUI's formats. */
  readonly workflow: unknown;
  /** Every size it is offered at, first is the default, and the memory a job at it needs. */
  readonly sizes: readonly { readonly width: number; readonly height: number; readonly bytes: number }[];
  /** False while every byte count is an estimate. */
  readonly measured: boolean;
  /** The picker's group: a theme for the app's own setups, where it came from for the rest. */
  readonly group: string;
  /** Words written around the person's prompt (a theme's wrapping). */
  readonly wrap?: { readonly prefix: string; readonly suffix: string };
  /** Where a file it loads can be downloaded from, by the name the workflow gives. */
  readonly sources?: Readonly<Record<string, ModelSource>>;
  /** Set when the workflow could not be read at all: why, in words. */
  readonly refused?: string;
}

/** Where a model file comes from: its ComfyUI folder kind and download address, and its size and hash once known. */
export interface ModelSource { readonly directory?: string; readonly url?: string; readonly bytes?: number; readonly sha256?: string }

/** The picker's groups, theme defaults first. */
export const GROUPS = { general: "General", portraits: "Portraits and people", pixel: "Pixel art", sprites: "Game sprites", backgrounds: "Backgrounds", templates: "ComfyUI templates", saved: "Your workflows", installed: "Your models" } as const;

/** The files the app's own setups load: where each is downloaded from, its size and sha256 (setups/files.json). */
const APP_FILES: Readonly<Record<string, ModelSource>> = fileSources;

const GIB = 1024 ** 3;

// The memory each of the app's setups needs is the smallest cap the GPU matrix of 2026-11-12 ran
// it under (ComfyUI 0.45.0, every size at most 1024x1024 pixels, warm): a cap it ran under, not a
// measured peak, so `measured` stays false. Klein with the full text encoder ran under 8 GiB and
// ran out of memory under 6; with the compact FP4 encoder it ran under 4. Z-Image Turbo int8 ran
// under 6, MOSS-Image under 4. The backgrounds' wide sizes have the same pixel count or fewer.
const sized = (gib: number) => (sizes: readonly (readonly [number, number])[]) => sizes.map(([width, height]) => ({ width, height, bytes: gib * GIB }));
const kleinSizes = sized(8);
const square = [[1024, 1024], [1024, 768], [768, 1024]] as const;
const klein4b = { family: "flux", sources: APP_FILES, measured: false } as const;

/**
 * The picker's rows: the General group's tier setups (TIERS) first, then the themes, which are
 * never a default.
 */
export const PRESETS: readonly Preset[] = [
  { ...klein4b, id: "flux2-klein-4b", name: "FLUX.2 Klein 4B", short: "Klein 4B", group: GROUPS.general, workflow: klein, sizes: kleinSizes(square) },
  // The same model with the FP4 text encoder and 12 steps (the matrix's compact-12): for a card with under 8 GiB free.
  { ...klein4b, id: "flux2-klein-4b-compact", name: "FLUX.2 Klein 4B compact", short: "Compact", group: GROUPS.general, workflow: kleinCompact, sizes: sized(4)(square) },
  { id: "z-image-int8", name: "Z-Image Turbo int8", short: "Z-Image", family: "zimage", group: GROUPS.general, workflow: zImage, sizes: sized(6)(square), sources: APP_FILES, measured: false },
  { id: "moss-image", name: "MOSS-Image", short: "MOSS", family: "moss", group: GROUPS.general, workflow: moss, sizes: sized(4)(square), sources: APP_FILES, measured: false },
  // The themes, on the model the 16 GB level uses for all five (the image-themes research,
  // 2026-11-12): its prompt wrapping and sizes; no quality or timing claim is measured.
  {
    ...klein4b, id: "flux2-klein-4b-portraits", name: "FLUX.2 Klein 4B portraits", short: "Faces", group: GROUPS.portraits, workflow: klein,
    wrap: { prefix: "Natural editorial portrait photograph. ", suffix: " Soft window light, realistic skin texture, clear eyes, both hands visible with relaxed separated fingers, simple uncluttered background." },
    sizes: kleinSizes([[832, 1216], [896, 1152], [1024, 1024]]),
  },
  // Pixel art and sprites are drawn square, then shrunk to 128 px and cut to 32 colours by
  // ComfyUI's own ImageScale and ImageQuantize: the picture that comes back is 128 x 128.
  {
    ...klein4b, id: "flux2-klein-4b-pixel", name: "FLUX.2 Klein 4B pixel art", short: "Retro pixel", group: GROUPS.pixel, workflow: kleinPixel,
    wrap: { prefix: "Pixel art, ", suffix: ". Crisp square pixel clusters, limited 32-color palette, simple readable shapes, deliberate hard edges, no lettering." },
    sizes: kleinSizes([[768, 768], [512, 512], [1024, 1024]]),
  },
  // A sprite comes back on a flat magenta field; cutting it out is not done here.
  {
    ...klein4b, id: "flux2-klein-4b-sprites", name: "FLUX.2 Klein 4B game sprites", short: "Sprites", group: GROUPS.sprites, workflow: kleinPixel,
    wrap: { prefix: "A single game character sprite, ", suffix: ". Full body entirely inside the frame with generous empty padding, three-quarter view facing right, readable silhouette, simple flat shading, isolated on a uniform solid pure magenta background (#FF00FF), no magenta on the subject, no ground, no cast shadow, no text, one subject only." },
    sizes: kleinSizes([[768, 768], [512, 512], [1024, 1024]]),
  },
  {
    ...klein4b, id: "flux2-klein-4b-backgrounds", name: "FLUX.2 Klein 4B backgrounds", short: "Backgrounds", group: GROUPS.backgrounds, workflow: klein,
    wrap: { prefix: "Environment concept art, ", suffix: ". Clear foreground, middle distance and distant horizon, coherent lighting, no lettering or watermark." },
    sizes: kleinSizes([[1344, 768], [1536, 640], [1216, 832], [768, 1344]]),
  },
];

/**
 * What an unset Settings choice runs: the first of these that fits the GPU room and is ready
 * (defaultChoice). Klein first, its compact setup standing in below 8 GiB (the Fast tier's own
 * swap), then Z-Image Turbo int8, then MOSS-Image. A saved choice is never replaced by one of
 * these. Its own rule, not "the first row", so a row added to PRESETS never becomes the default by
 * its place.
 */
export const DEFAULT_ORDER: readonly ImageChoice[] = [
  { preset: "flux2-klein-4b", width: 1024, height: 1024 },
  { preset: "flux2-klein-4b-compact", width: 1024, height: 1024 },
  { preset: "z-image-int8", width: 1024, height: 1024 },
  { preset: "moss-image", width: 1024, height: 1024 },
];

/** On a card smaller than this no setup of the app's runs: there is no default and the picker says so. */
export const MIN_ROOM = 4 * GIB;
export const NO_GPU = "Image mode needs a GPU with 4 GB.";

/**
 * A card's size from nvidia-smi's total, to the nearest GB as cards are sold: 8188 MiB is an 8 GB
 * card, 16303 MiB a 16 GB one. The tiers and the default go by it, never by what is free now
 * (owner ruling 2026-11-13); the job's own fit check judges what is free when it runs.
 */
export const cardBytes = (totalBytes: number): number => Math.round(totalBytes / GIB) * GIB;

/**
 * The quality tiers of the owner's picks (2026-11-13): each takes the first of its setups whose
 * first size fits the card (cardBytes). Fast: Klein on an 8 GB card, compact below. Balanced:
 * Z-Image Turbo int8 on 6 GB, Klein compact on 4. Best: MOSS-Image on 4.
 */
export const TIERS: readonly { readonly name: string; readonly presets: readonly string[] }[] = [
  { name: "Fast", presets: ["flux2-klein-4b", "flux2-klein-4b-compact"] },
  { name: "Balanced", presets: ["z-image-int8", "flux2-klein-4b-compact"] },
  { name: "Best", presets: ["moss-image"] },
];

const firstBytes = (id: string): number => PRESETS.find((p) => p.id === id)!.sizes[0]!.bytes;
/** Room unknown (no reading, or a ComfyUI on another machine) fits everything; the job's own check still runs. */
const fits = (bytes: number, room: number | undefined): boolean => room === undefined || bytes <= room;

/**
 * Each tier's setup for a card of `room` bytes (cardBytes), in tier order, with its label ("Fast",
 * or "Fast and balanced" when one setup is two tiers' pick). Empty below MIN_ROOM.
 */
export function tiersFor(room: number | undefined): { preset: string; tier: string }[] {
  if (room !== undefined && room < MIN_ROOM) return [];
  const out: { preset: string; names: string[] }[] = [];
  for (const t of TIERS) {
    const id = t.presets.find((p) => fits(firstBytes(p), room));
    if (id === undefined) continue;
    const seen = out.find((o) => o.preset === id);
    if (seen === undefined) out.push({ preset: id, names: [t.name] });
    else seen.names.push(t.name.toLowerCase());
  }
  return out.map((o) => ({ preset: o.preset, tier: o.names.join(" and ") }));
}

/** Absent, or one of DEFAULT_ORDER. */
export const isDefaultChoice = (c: ImageChoice | undefined): boolean =>
  c === undefined || DEFAULT_ORDER.some((d) => d.preset === c.preset && d.width === c.width && d.height === c.height);

/** An unset choice before ComfyUI's lists have been read: the first of DEFAULT_ORDER. */
export const DEFAULT_CHOICE: ImageChoice = DEFAULT_ORDER[0]!;

/**
 * The preset and size a choice names, from the app's own and `extra` (the workflows ComfyUI had,
 * workflowPresets). An unknown preset or a size it does not run at is refused, never swapped.
 */
export function resolveChoice(choice: ImageChoice, extra: readonly Preset[] = []): { preset: Preset; size: Preset["sizes"][number] } {
  const preset = PRESETS.find((p) => p.id === choice.preset) ?? extra.find((p) => p.id === choice.preset);
  if (preset === undefined) throw Object.assign(new Error(`There is no image preset ${choice.preset}. Pick an image model in the composer.`), { code: "image-model" });
  const size = preset.sizes.find((s) => s.width === choice.width && s.height === choice.height);
  if (size === undefined) throw Object.assign(new Error(`${preset.name} does not run at ${choice.width} x ${choice.height}. Pick one of its sizes.`), { code: "image-model" });
  return { preset, size };
}

/** For each `Class.input` that takes a model file, the file names ComfyUI lists there. */
export type LoaderFiles = Readonly<Record<string, readonly string[]>>;
/** What the app keeps of /object_info: the file lists and, once read, every node class it lists. */
export interface ComfyLists { readonly files: LoaderFiles; readonly classes?: readonly string[] }

/** An /object_info stand-in that lists every node class (with no inputs): for judging files alone. */
const EVERY_CLASS: ObjectInfo = new Proxy({}, { get: () => ({}) });
const MODEL_FILE = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx)$/i;
const Spec = S.Struct({ input: S.optional(S.Struct({ required: S.optional(S.Record(S.String, S.Unknown)), optional: S.optional(S.Record(S.String, S.Unknown)) })) });

/** A combo input's options in either of /object_info's spellings, else undefined. */
function comboOptions(def: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(def)) return undefined;
  if (Array.isArray(def[0])) return def[0] as unknown[];
  if (def[0] === "COMBO" && typeof def[1] === "object" && def[1] !== null && Array.isArray((def[1] as { options?: unknown }).options)) return (def[1] as { options: unknown[] }).options;
  return undefined;
}

/** The file lists and node classes in a /object_info answer. */
export function comfyLists(info: ObjectInfo): ComfyLists & { classes: readonly string[] } {
  const files: Record<string, string[]> = {};
  for (const [name, raw] of Object.entries(info)) {
    const spec = S.decodeUnknownOption(Spec)(raw);
    if (Option.isNone(spec)) continue;
    for (const [field, def] of Object.entries({ ...spec.value.input?.required, ...spec.value.input?.optional })) {
      const options = comboOptions(def);
      if (options === undefined) continue;
      const names = options.filter((v): v is string => typeof v === "string");
      // a file list, never a list of sampler or scheduler names; an empty list and no list both mean no files
      if (names.some((v) => MODEL_FILE.test(v))) files[`${name}.${field}`] = names;
    }
  }
  return { files, classes: Object.keys(info) };
}

/** A file a graph loads: the node, its input, and the name the workflow gives. */
export interface GraphFile { readonly node: string; readonly key: string; readonly input: string; readonly name: string }

/** Every model file a graph loads: the inputs whose value is a model file name. */
export function graphFiles(graph: ApiGraph): GraphFile[] {
  const out: GraphFile[] = [];
  for (const [node, { class_type, inputs }] of Object.entries(graph)) {
    for (const [input, value] of Object.entries(inputs)) if (typeof value === "string" && MODEL_FILE.test(value)) out.push({ node, input, key: `${class_type}.${input}`, name: value });
  }
  return out;
}

/** The model files a setup's workflow loads, as it names them (its file lists not consulted). */
export function presetFiles(preset: Preset): string[] {
  return graphFiles(convertWorkflow(preset.workflow, EVERY_CLASS)).map((f) => f.name);
}

/** The name ComfyUI lists for this file (it may sit in a subfolder), or undefined when it lists none. */
export function findFile(files: LoaderFiles, file: Pick<GraphFile, "key" | "name">): string | undefined {
  const base = file.name.replaceAll("\\", "/").split("/").at(-1)!;
  return files[file.key]?.find((v) => v === file.name || v.replaceAll("\\", "/").endsWith(`/${base}`) || v === base);
}

/** The setup's graph as Image mode would run it, or why it cannot: refused (WorkflowRefusal) or missing files. */
function judge(preset: Preset, lists: ComfyLists): { graph: ApiGraph; missing: GraphFile[] } {
  if (preset.refused !== undefined) throw new WorkflowRefusal(preset.refused);
  // Before ComfyUI's class list was kept, every class counts as listed.
  const info: ObjectInfo = lists.classes === undefined ? EVERY_CLASS : Object.fromEntries(lists.classes.map((c) => [c, {}]));
  const graph = convertWorkflow(preset.workflow, info);
  findControls(graph);
  return { graph, missing: graphFiles(graph).filter((f) => findFile(lists.files, f) === undefined) };
}

const row = (p: Preset): ImagePreset => ({ id: p.id, name: p.name, short: p.short, family: p.family, group: p.group, measured: p.measured, sizes: p.sizes.map((s) => ({ ...s })) });

/** A Hugging Face address and a folder kind: what image.download needs to fetch a file. */
const fetchable = (source: ModelSource | undefined): boolean => {
  if (source?.url === undefined || source.directory === undefined) return false;
  try { return huggingFace(new URL(source.url), false); } catch { return false; }
};

/** The files to fetch, their total size when every one's is known, and whether image.download can fetch them all. */
function needs(preset: Preset, missing: readonly GraphFile[]): NonNullable<ImagePreset["needs"]> {
  const files = [...new Set(missing.map((f) => f.name))];
  const sizes = files.map((f) => preset.sources?.[f]?.bytes);
  return {
    files,
    ...sizes.every((b) => b !== undefined) ? { bytes: sizes.reduce((a, b) => a + b, 0) } : {},
    ...files.every((f) => fetchable(preset.sources?.[f])) ? { download: true } : {},
  };
}

/** Every setup as the picker lists it: the ready ones, and the rest with what stops them. */
export function listPresets(lists: ComfyLists, extra: readonly Preset[] = []): { ready: ImagePreset[]; others: ImagePreset[] } {
  const ready: ImagePreset[] = [], others: ImagePreset[] = [];
  for (const p of [...PRESETS, ...extra]) {
    try {
      const { missing } = judge(p, lists);
      if (missing.length === 0) ready.push(row(p));
      else others.push({ ...row(p), needs: needs(p, missing) });
    } catch (error) {
      if (!(error instanceof WorkflowRefusal)) throw error;
      others.push({ ...row(p), why: error.message });
    }
  }
  return { ready, others };
}

/** The presets ComfyUI has every class and file for, as the picker shows them. */
export const availablePresets = (lists: ComfyLists, extra: readonly Preset[] = []): ImagePreset[] => listPresets(lists, extra).ready;

/**
 * The graph a job sends: the setup's workflow with the prompt, size and seed written in and each
 * file named as ComfyUI lists it. Throws `image-model` (with `file`) when a file is not listed,
 * and `image-model` with the reason when the workflow is refused.
 */
export function jobGraph(preset: Preset, info: ObjectInfo, values: { prompt: string; seed: number; width: number; height: number }): ApiGraph {
  const lists = comfyLists(info);
  let graph: ApiGraph;
  try {
    if (preset.refused !== undefined) throw new WorkflowRefusal(preset.refused);
    graph = convertWorkflow(preset.workflow, info);
  }
  catch (error) { throw error instanceof WorkflowRefusal ? Object.assign(new Error(`${preset.name}: ${error.message}`), { code: "image-model" }) : error; }
  for (const file of graphFiles(graph)) {
    const listed = findFile(lists.files, file);
    if (listed === undefined) throw Object.assign(new Error(`ComfyUI model ${file.name} is absent. Install it in ComfyUI's model folders, then retry.`), { code: "image-model", file: file.name });
    graph[file.node]!.inputs[file.input] = listed;
  }
  const prompt = preset.wrap === undefined ? values.prompt : `${preset.wrap.prefix}${values.prompt}${preset.wrap.suffix}`;
  try { return applyControls(graph, findControls(graph), { ...values, prompt }); }
  catch (error) { throw error instanceof WorkflowRefusal ? Object.assign(new Error(`${preset.name}: ${error.message}`), { code: "image-model" }) : error; }
}

/**
 * A refusal's way out: the first setup and size in the picker's list (availablePresets) that needs
 * less than `needBytes` and fits in `roomBytes`, named as the picker names it. Undefined when none
 * would (each of the app's setups needs the same at every size; 4 GiB is the smallest need there is).
 */
export function smallerFit(lists: ComfyLists | undefined, needBytes: number, roomBytes: number, extra: readonly Preset[] = []): string | undefined {
  for (const p of lists === undefined ? [] : availablePresets(lists, extra)) {
    const size = p.sizes.find((s) => s.bytes < needBytes && s.bytes <= roomBytes);
    if (size !== undefined) return `${p.name} ${size.width}×${size.height}`;
  }
  return undefined;
}

/** A choice as the composer names it. One this build no longer runs (an older preset id) names the default. */
export function describeChoice(choice: ImageChoice, fallback: ImageChoice, extra: readonly Preset[] = []): { preset: ImagePreset; width: number; height: number } {
  for (const c of [choice, fallback, DEFAULT_CHOICE]) {
    try { const { preset } = resolveChoice(c, extra); return { preset: row(preset), width: c.width, height: c.height }; }
    catch { /* try the next */ }
  }
  return { preset: row(PRESETS[0]!), width: DEFAULT_CHOICE.width, height: DEFAULT_CHOICE.height };
}

/** Tools › Make images as the person left it: on or off when they flipped it, else on exactly while a setup can run. */
export function imageToolOn(settings: Pick<Settings, "imageGen" | "imageTool">, runnable: boolean): boolean {
  return settings.imageGen === true && (settings.imageTool ?? runnable);
}

/**
 * The system prompt's one line for a chat turn without the image tool, so a model asked for a
 * picture says what turns it on here instead of naming another app. `toolsOn`: the turn runs tools
 * (Let the model use tools). Undefined when the tool is offered.
 */
export function imageOffLine(settings: Pick<Settings, "imageGen" | "imageTool">, runnable: boolean, toolsOn: boolean): string | undefined {
  if (toolsOn && imageToolOn(settings, runnable)) return undefined;
  const say = !settings.imageGen ? "Turn on Generate images in Settings > Image generation."
    : !runnable && settings.imageTool !== false ? "Set up an image model in Settings > Image generation."
    : !toolsOn ? "Turn on Let the model use tools and Make images in Settings > Tools, or switch the message box to Image."
    : "Turn on Make images in Settings > Tools, or switch the message box to Image.";
  return `You cannot make images in this chat. If asked for one, say: "${say}" Never send the person to another app or website for it.`;
}

/**
 * Tools › Make images: the choice a chat model's image tool runs, or undefined when the tool is
 * off. It needs image generation on too. Unset is on once a setup can run (`runnable`); an
 * explicit off stays off.
 */
export function imageToolChoice(settings: Pick<Settings, "imageGen" | "imageTool" | "imageChoice">, runnable: boolean, lists?: ComfyLists, extra: readonly Preset[] = []): ImageChoice | undefined {
  // with no default (no GPU room), DEFAULT_CHOICE: the job's own check then refuses it in words
  return imageToolOn(settings, runnable) ? (settings.imageChoice ?? defaultChoice(lists, extra) ?? DEFAULT_CHOICE) : undefined;
}

/**
 * The default for an unset choice, for a card of `room` bytes (cardBytes; undefined: unknown, so any):
 * undefined below MIN_ROOM (no CPU default; NO_GPU says why). Else the first of DEFAULT_ORDER that
 * fits and is ready, else the first that fits even when not ready, so the send says which files
 * are missing (and the picker offers the download) rather than running some other row. Only
 * DEFAULT_ORDER's setups are ever a default, never a template or a person's own.
 */
export function defaultChoice(lists: ComfyLists | undefined, extra: readonly Preset[] = [], room?: number): ImageChoice | undefined {
  if (room !== undefined && room < MIN_ROOM) return undefined;
  const fitting = DEFAULT_ORDER.filter((c) => fits(firstBytes(c.preset), room));
  if (lists === undefined) return fitting[0];
  const available = availablePresets(lists, extra);
  return fitting.find((c) => available.some((p) => p.id === c.preset)) ?? fitting[0];
}

/**
 * A workflow read from ComfyUI (sources.ts), as the app keeps it: its API graph once converted, or
 * why it could not be, and where the files it names come from (the file's `properties.models`).
 */
export interface KnownWorkflow {
  readonly id: string;
  readonly name: string;
  readonly group: string;
  readonly graph?: unknown;
  readonly why?: string;
  readonly sources?: Readonly<Record<string, ModelSource>>;
  /** The family mark, when it is known from the files' headers (installed.ts) rather than guessed. */
  readonly family?: string;
}

/** Guessed from the files it loads, for the mark beside its name; "comfy" when none is known. */
function familyOf(graph: ApiGraph): string {
  const names = graphFiles(graph).map((f) => f.name.toLowerCase()).join(" ");
  // MOSS-Image loads FLUX.2's VAE: a model's own name goes before the VAE it borrows
  if (/moss[_-]?image/.test(names)) return "moss";
  if (/z[_-]?image/.test(names)) return "zimage";
  if (/flux/.test(names)) return "flux";
  if (/sd_?xl/.test(names)) return "sdxl";
  if (/qwen[_-]?image/.test(names)) return "qwen";
  return "comfy";
}

/**
 * The research's memory rule for a workflow with no measured figure: the largest file it loads
 * plus 1.5 GiB, not a measured peak. With no file's size known, 10 GiB, the app's own largest estimate.
 */
function estimateBytes(graph: ApiGraph, sources: Readonly<Record<string, ModelSource>>): number {
  const known = graphFiles(graph).map((f) => sources[f.name]?.bytes ?? APP_FILES[f.name]?.bytes).filter((b): b is number => b !== undefined);
  return known.length === 0 ? 10 * GIB : Math.max(...known) + 1.5 * GIB;
}

/** A kept workflow as a setup: its own size only, the memory estimated, never measured. */
export function workflowPreset(w: KnownWorkflow): Preset {
  const base = { id: w.id, name: w.name, short: w.name, group: w.group, workflow: w.graph, measured: false, sources: w.sources ?? {} };
  if (w.why !== undefined) return { ...base, family: w.family ?? "comfy", sizes: [], refused: w.why };
  try {
    const graph = convertWorkflow(w.graph, EVERY_CLASS);
    const { size } = findControls(graph);
    return { ...base, family: w.family ?? familyOf(graph), sizes: [{ ...size, bytes: estimateBytes(graph, base.sources) }] };
  } catch (error) {
    if (!(error instanceof WorkflowRefusal)) throw error;
    return { ...base, family: w.family ?? "comfy", sizes: [], refused: error.message };
  }
}
