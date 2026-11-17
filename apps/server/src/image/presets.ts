import { cardBytes, MIN_ROOM, type ImageChoice, type ImagePreset, type Settings } from "@gates-local/contracts";
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
import { cellsFor, compactStandIn, levelOf, STYLE_CELLS, type StyleCell } from "./styles.ts";

export interface Preset {
  readonly id: string;
  readonly name: string;
  // why: each name starts with its own letter, so a narrow button never shows two setups alike
  readonly short: string;
  readonly family: string;
  readonly workflow: unknown;
  readonly sizes: readonly { readonly width: number; readonly height: number; readonly bytes: number }[];
  readonly measured: boolean;
  readonly group: string;
  readonly model?: string;
  readonly wrap?: { readonly prefix: string; readonly suffix: string };
  readonly sources?: Readonly<Record<string, ModelSource>>;
  readonly refused?: string;
}

export interface ModelSource { readonly directory?: string; readonly url?: string; readonly bytes?: number; readonly sha256?: string }

export const GROUPS = { general: "General", portraits: "Portraits and people", characters: "Characters", pixel: "Pixel art", sprites: "Game sprites", backgrounds: "Backgrounds", icons: "Icons", text: "Text and logos", painterly: "Painterly and concept art", templates: "ComfyUI templates", saved: "Your workflows", installed: "Your models" } as const;

const APP_FILES: Readonly<Record<string, ModelSource>> = fileSources;

const GIB = 1024 ** 3;

// why: each figure is the smallest memory cap the setup ran under in the GPU matrix, not a peak
const sized = (gib: number) => (sizes: readonly (readonly [number, number])[]) => sizes.map(([width, height]) => ({ width, height, bytes: gib * GIB }));
const kleinSizes = sized(8);
const square = [[1024, 1024], [1024, 768], [768, 1024]] as const;
const klein4b = { family: "flux", sources: APP_FILES, measured: false } as const;

export const PRESETS: readonly Preset[] = [
  { ...klein4b, id: "flux2-klein-4b", name: "FLUX.2 Klein 4B", short: "Klein 4B", group: GROUPS.general, workflow: klein, sizes: kleinSizes(square) },
  { ...klein4b, id: "flux2-klein-4b-compact", name: "FLUX.2 Klein 4B", short: "Klein 4B", group: GROUPS.general, workflow: kleinCompact, sizes: sized(4)(square) },
  { id: "z-image-int8", name: "Z-Image Turbo int8", short: "Z-Image", family: "zimage", group: GROUPS.general, workflow: zImage, sizes: sized(6)(square), sources: APP_FILES, measured: false },
  { id: "moss-image", name: "MOSS-Image", short: "MOSS", family: "moss", group: GROUPS.general, workflow: moss, sizes: sized(4)(square), sources: APP_FILES, measured: false },
];

export const RETIRED: readonly Preset[] = [
  {
    ...klein4b, id: "flux2-klein-4b-portraits", name: "FLUX.2 Klein 4B portraits", short: "Faces", group: GROUPS.portraits, workflow: klein,
    wrap: { prefix: "Natural editorial portrait photograph. ", suffix: " Soft window light, realistic skin texture, clear eyes, both hands visible with relaxed separated fingers, simple uncluttered background." },
    sizes: kleinSizes([[832, 1216], [896, 1152], [1024, 1024]]),
  },
  {
    ...klein4b, id: "flux2-klein-4b-pixel", name: "FLUX.2 Klein 4B pixel art", short: "Retro pixel", group: GROUPS.pixel, workflow: kleinPixel,
    wrap: { prefix: "Pixel art, ", suffix: ". Crisp square pixel clusters, limited 32-color palette, simple readable shapes, deliberate hard edges, no lettering." },
    sizes: kleinSizes([[768, 768], [512, 512], [1024, 1024]]),
  },
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

// why: an explicit list, so a row added to PRESETS never becomes the default by its place
export const DEFAULT_ORDER: readonly ImageChoice[] = [
  { preset: "flux2-klein-4b", width: 1024, height: 1024 },
  { preset: "flux2-klein-4b-compact", width: 1024, height: 1024 },
  { preset: "z-image-int8", width: 1024, height: 1024 },
  { preset: "moss-image", width: 1024, height: 1024 },
];

export const NO_GPU = "Image mode needs a GPU with 4 GB.";
// why: the basic-PC bench took 100 to 235 seconds a picture on the processor
export const SLOW = "No GPU: a picture takes 2 to 4 minutes.";

export { cardBytes, MIN_ROOM };

export const TIERS: readonly { readonly name: string; readonly presets: readonly string[] }[] = [
  { name: "Fast", presets: ["flux2-klein-4b", "flux2-klein-4b-compact"] },
  { name: "Balanced", presets: ["z-image-int8", "flux2-klein-4b-compact"] },
  { name: "Best", presets: ["moss-image"] },
];

// why: MOSS took 13 to 15 GiB of RAM in the bench, and a 32 GB computer reports under 32 GiB
export const MOSS_RAM = 30 * GIB;
const mossFits = (ram: number | undefined): boolean => ram === undefined || ram >= MOSS_RAM;

const presetById = (id: string): Preset => PRESETS.find((p) => p.id === id)!;
const firstBytes = (id: string): number => presetById(id).sizes[0]!.bytes;
const fits = (bytes: number, room: number | undefined): boolean => room === undefined || bytes <= room;

const KLEIN = ["flux2-klein-4b", "flux2-klein-4b-compact"] as const;
export const kleinFor = (room: number | undefined): (typeof KLEIN)[number] => fits(firstBytes(KLEIN[0]), room) ? KLEIN[0] : KLEIN[1];
const isKlein = (id: string): boolean => (KLEIN as readonly string[]).includes(id);
export const sameRow = (a: string, b: string): boolean => a === b || isKlein(a) && isKlein(b);
function kleinRow(room: number | undefined, runs: (p: Preset) => boolean): string {
  const card = kleinFor(room), other = card === KLEIN[0] ? KLEIN[1] : KLEIN[0];
  return !runs(presetById(card)) && runs(presetById(other)) && (room === 0 || fits(firstBytes(other), room)) ? other : card;
}

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

const cellChoice = (c: StyleCell): ImageChoice => ({ preset: c.id, width: c.sizes[0]!.width, height: c.sizes[0]!.height });
const generalCell = (level: NonNullable<ReturnType<typeof levelOf>>): StyleCell => cellsFor(level).find((c) => c.style === "general")!;

export const isDefaultChoice = (c: ImageChoice | undefined): boolean =>
  c === undefined || [...DEFAULT_ORDER, ...STYLE_CELLS.filter((s) => s.style === "general").map(cellChoice)].some((d) => d.preset === c.preset && d.width === c.width && d.height === c.height);

export const DEFAULT_CHOICE: ImageChoice = cellChoice(generalCell("16"));

const APP_PRESETS: readonly Preset[] = [...PRESETS, ...STYLE_CELLS, ...RETIRED];
export const appPreset = (id: string): Preset | undefined => APP_PRESETS.find((p) => p.id === id);

export const liveChoice = (choice: ImageChoice | undefined): ImageChoice | undefined =>
  choice === undefined || choice.preset.includes(":") || appPreset(choice.preset) !== undefined ? choice : undefined;

export function resolveChoice(choice: ImageChoice, extra: readonly Preset[] = []): { preset: Preset; size: Preset["sizes"][number] } {
  const preset = appPreset(choice.preset) ?? extra.find((p) => p.id === choice.preset);
  if (preset === undefined) throw Object.assign(new Error(`There is no image preset ${choice.preset}. Pick an image model in the composer.`), { code: "image-model" });
  const size = preset.sizes.find((s) => s.width === choice.width && s.height === choice.height);
  if (size === undefined) throw Object.assign(new Error(`${preset.name} does not run at ${choice.width} x ${choice.height}. Pick one of its sizes.`), { code: "image-model" });
  return { preset, size };
}

export type LoaderFiles = Readonly<Record<string, readonly string[]>>;
export interface ComfyLists { readonly files: LoaderFiles; readonly classes?: readonly string[] }

const EVERY_CLASS: ObjectInfo = new Proxy({}, { get: () => ({}) });
const MODEL_FILE = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx)$/i;
const Spec = S.Struct({ input: S.optional(S.Struct({ required: S.optional(S.Record(S.String, S.Unknown)), optional: S.optional(S.Record(S.String, S.Unknown)) })) });

// external: ComfyUI's /object_info spells a combo as [options] or as ["COMBO", { options }]
function comboOptions(def: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(def)) return undefined;
  if (Array.isArray(def[0])) return def[0] as unknown[];
  if (def[0] === "COMBO" && typeof def[1] === "object" && def[1] !== null && Array.isArray((def[1] as { options?: unknown }).options)) return (def[1] as { options: unknown[] }).options;
  return undefined;
}

export function comfyLists(info: ObjectInfo): ComfyLists & { classes: readonly string[] } {
  const files: Record<string, string[]> = {};
  for (const [name, raw] of Object.entries(info)) {
    const spec = S.decodeUnknownOption(Spec)(raw);
    if (Option.isNone(spec)) continue;
    for (const [field, def] of Object.entries({ ...spec.value.input?.required, ...spec.value.input?.optional })) {
      const options = comboOptions(def);
      if (options === undefined) continue;
      const names = options.filter((v): v is string => typeof v === "string");
      // why: ComfyUI combos also list samplers and schedulers, so only lists of model files count
      if (names.some((v) => MODEL_FILE.test(v))) files[`${name}.${field}`] = names;
    }
  }
  return { files, classes: Object.keys(info) };
}

export interface GraphFile { readonly node: string; readonly key: string; readonly input: string; readonly name: string }

export function graphFiles(graph: ApiGraph): GraphFile[] {
  const out: GraphFile[] = [];
  for (const [node, { class_type, inputs }] of Object.entries(graph)) {
    for (const [input, value] of Object.entries(inputs)) if (typeof value === "string" && MODEL_FILE.test(value)) out.push({ node, input, key: `${class_type}.${input}`, name: value });
  }
  return out;
}

export function presetFiles(preset: Preset): string[] {
  return graphFiles(convertWorkflow(preset.workflow, EVERY_CLASS)).map((f) => f.name);
}

// external: ComfyUI's loader nodes read each input from one folder under models/
const FOLDER_OF_INPUT: Readonly<Record<string, string>> = { unet_name: "diffusion_models", ckpt_name: "checkpoints", lora_name: "loras", vae_name: "vae" };

export function folderOf(key: string): { folder?: string } {
  const input = key.split(".").at(-1) ?? "";
  const folder = FOLDER_OF_INPUT[input] ?? (input.startsWith("clip_name") ? "text_encoders" : undefined);
  return folder === undefined ? {} : { folder };
}

export function findFile(files: LoaderFiles, file: Pick<GraphFile, "key" | "name">): string | undefined {
  const base = file.name.replaceAll("\\", "/").split("/").at(-1)!;
  return files[file.key]?.find((v) => v === file.name || v.replaceAll("\\", "/").endsWith(`/${base}`) || v === base);
}

function judge(preset: Preset, lists: ComfyLists): { graph: ApiGraph; missing: GraphFile[] } {
  if (preset.refused !== undefined) throw new WorkflowRefusal(preset.refused);
  const info: ObjectInfo = lists.classes === undefined ? EVERY_CLASS : Object.fromEntries(lists.classes.map((c) => [c, {}]));
  const graph = convertWorkflow(preset.workflow, info);
  findControls(graph);
  return { graph, missing: graphFiles(graph).filter((f) => findFile(lists.files, f) === undefined) };
}

const row = (p: Preset): ImagePreset => ({
  id: p.id, name: p.name, short: p.short, family: p.family, group: p.group, measured: p.measured, sizes: p.sizes.map((s) => ({ ...s })),
  ...p.model === undefined ? {} : { model: p.model },
  ...(p as Partial<StyleCell>).style === undefined ? {} : { style: (p as StyleCell).style },
});

const fetchable = (source: ModelSource | undefined): boolean => {
  if (source?.url === undefined || source.directory === undefined) return false;
  try { return huggingFace(new URL(source.url), false); } catch { return false; }
};

function needs(preset: Preset, missing: readonly GraphFile[]): NonNullable<ImagePreset["needs"]> {
  const files = [...new Set(missing.map((f) => f.name))];
  const sizes = files.map((f) => preset.sources?.[f]?.bytes);
  return {
    files,
    ...sizes.every((b) => b !== undefined) ? { bytes: sizes.reduce((a, b) => a + b, 0) } : {},
    ...files.every((f) => fetchable(preset.sources?.[f])) ? { download: true } : {},
  };
}

export function listPresets(lists: ComfyLists, extra: readonly Preset[] = [], room?: number, ram?: number): { ready: ImagePreset[]; others: ImagePreset[] } {
  const ready: ImagePreset[] = [], others: ImagePreset[] = [];
  const level = levelOf(room);
  const cells = new Set<Preset>(cellsFor(level));
  const runs = (p: Preset) => { try { return judge(p, lists).missing.length === 0; } catch { return false; } };
  const unstyled = new Set<Preset>(mossFits(ram) || level === undefined ? [] : cellsFor(level).filter((c) => c.family === "moss" && compactStandIn(c, level) !== undefined));
  const kleinId = kleinRow(room, runs);
  const list = [...PRESETS.filter((p) => !isKlein(p.id) || p.id === kleinId), ...cellsFor(level), ...extra].flatMap((p) => unstyled.has(p) ? [compactStandIn(p as StyleCell, level!)!, p] : [p]);
  const listed = (p: Preset): ImagePreset => { const r = row(p); if (!unstyled.has(p)) return r; const { style: _, ...rest } = r; return rest; };
  for (const p of list) {
    try {
      const { missing } = judge(p, lists);
      if (missing.length === 0) ready.push(listed(p));
      else {
        const standIn = cells.has(p) && !unstyled.has(p) && level !== undefined ? compactStandIn(p as StyleCell, level) : undefined;
        if (standIn !== undefined && runs(standIn)) ready.push(row(standIn));
        others.push({ ...listed(p), needs: needs(p, missing) });
      }
    } catch (error) {
      if (!(error instanceof WorkflowRefusal)) throw error;
      others.push({ ...listed(p), why: error.message });
    }
  }
  return { ready, others };
}

export function judgeRow(lists: ComfyLists, p: Preset): ImagePreset {
  try {
    const { missing } = judge(p, lists);
    return missing.length === 0 ? row(p) : { ...row(p), needs: needs(p, missing) };
  } catch (error) {
    if (!(error instanceof WorkflowRefusal)) throw error;
    return { ...row(p), why: error.message };
  }
}

export const availablePresets = (lists: ComfyLists, extra: readonly Preset[] = [], room?: number, ram?: number): ImagePreset[] => listPresets(lists, extra, room, ram).ready;

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
    if (listed === undefined) throw Object.assign(new Error(`ComfyUI model ${file.name} is absent. Install it in ComfyUI's model folders, then retry.`), { code: "image-model", file: file.name, ...folderOf(file.key) });
    graph[file.node]!.inputs[file.input] = listed;
  }
  const prompt = preset.wrap === undefined ? values.prompt : `${preset.wrap.prefix}${values.prompt}${preset.wrap.suffix}`;
  try { return applyControls(graph, findControls(graph), { ...values, prompt }); }
  catch (error) { throw error instanceof WorkflowRefusal ? Object.assign(new Error(`${preset.name}: ${error.message}`), { code: "image-model" }) : error; }
}

export function smallerFit(lists: ComfyLists | undefined, needBytes: number, roomBytes: number, extra: readonly Preset[] = []): string | undefined {
  for (const p of lists === undefined ? [] : availablePresets(lists, extra)) {
    const size = p.sizes.find((s) => s.bytes < needBytes && s.bytes <= roomBytes);
    if (size !== undefined) return `${p.name} ${size.width}×${size.height}`;
  }
  return undefined;
}

export function describeChoice(choice: ImageChoice, fallback: ImageChoice, extra: readonly Preset[] = []): { preset: ImagePreset; width: number; height: number } {
  for (const c of [choice, fallback, DEFAULT_CHOICE]) {
    try { const { preset } = resolveChoice(c, extra); return { preset: row(preset), width: c.width, height: c.height }; }
    catch {}
  }
  return { preset: row(PRESETS[0]!), width: DEFAULT_CHOICE.width, height: DEFAULT_CHOICE.height };
}

export function imageToolOn(settings: Pick<Settings, "imageGen" | "imageTool">, runnable: boolean): boolean {
  return settings.imageGen === true && (settings.imageTool ?? runnable);
}

export function imageOffLine(settings: Pick<Settings, "imageGen" | "imageTool">, runnable: boolean, toolsOn: boolean): string | undefined {
  if (toolsOn && imageToolOn(settings, runnable)) return undefined;
  const say = !settings.imageGen ? "Turn on Generate images in Settings > Image generation."
    : !runnable && settings.imageTool !== false ? "Set up an image model in Settings > Image generation."
    : !toolsOn ? "Turn on Let the model use tools and Make images in Settings > Tools, or switch the message box to Image."
    : "Turn on Make images in Settings > Tools, or switch the message box to Image.";
  // why: beside a tool list, a model read "you cannot" as every tool being off and said so
  const off = toolsOn ? "Making images is off in this chat; every other tool you have still works." : "Making images is off in this chat.";
  return `${off} If asked for an image, say: "${say}" Never send the person to another app or website for it.`;
}

export function imageToolChoice(settings: Pick<Settings, "imageGen" | "imageTool" | "imageChoice">, runnable: boolean, lists?: ComfyLists, extra: readonly Preset[] = []): ImageChoice | undefined {
  return imageToolOn(settings, runnable) ? (liveChoice(settings.imageChoice) ?? defaultChoice(lists, extra) ?? DEFAULT_CHOICE) : undefined;
}

export function defaultChoice(lists: ComfyLists | undefined, extra: readonly Preset[] = [], room?: number, ram?: number): ImageChoice | undefined {
  const level = levelOf(room);
  if (level === undefined) return undefined;
  const order = mossFits(ram) ? DEFAULT_ORDER : DEFAULT_ORDER.filter((c) => PRESETS.find((p) => p.id === c.preset)?.family !== "moss");
  const fitting = [cellChoice(generalCell(level)), ...level === "cpu" ? [] : order.filter((c) => fits(firstBytes(c.preset), room))];
  if (lists === undefined) return fitting[0];
  const available = availablePresets(lists, extra, room, ram);
  return fitting.find((c) => available.some((p) => p.id === c.preset)) ?? fitting[0];
}

export interface KnownWorkflow {
  readonly id: string;
  readonly name: string;
  readonly group: string;
  readonly graph?: unknown;
  readonly why?: string;
  readonly sources?: Readonly<Record<string, ModelSource>>;
  readonly family?: string;
}

function familyOf(graph: ApiGraph): string {
  const names = graphFiles(graph).map((f) => f.name.toLowerCase()).join(" ");
  // external: MOSS-Image workflows load FLUX.2's VAE, so a flux file name appears in them too
  if (/moss[_-]?image/.test(names)) return "moss";
  if (/z[_-]?image/.test(names)) return "zimage";
  if (/flux/.test(names)) return "flux";
  if (/sd_?xl/.test(names)) return "sdxl";
  if (/qwen[_-]?image/.test(names)) return "qwen";
  return "comfy";
}

function estimateBytes(graph: ApiGraph, sources: Readonly<Record<string, ModelSource>>): number {
  const known = graphFiles(graph).map((f) => sources[f.name]?.bytes ?? APP_FILES[f.name]?.bytes).filter((b): b is number => b !== undefined);
  return known.length === 0 ? 10 * GIB : Math.max(...known) + 1.5 * GIB;
}

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
