// The Defaults menu's setups: for each style and each card level, the style bench's provisional
// winner (owner ruling 2026-11-13: "the provisional winners for all are good enough"). A cell is
// one of the app's own graphs (setups/) tuned the way the bench ran it: which text encoder, the
// steps, the guidance, the size, the words written before the person's prompt, and any resize or
// colour cut after the picture is decoded. The GPU cells are the bench's final round of
// 2026-11-13; the CPU cells are its basic-PC finalists (an i5-8500 with 16 GB, no GPU), run with
// the person's words alone as the bench ran them.
//
// A card's level is its memory to the nearest GB (cardBytes) rounded down to one the bench ran:
// 16 (and above), 12, 8, 6 or 4; "cpu" when ComfyUI runs on the processor. The picker lists only
// the cells of this machine's level, so each style has one row in Defaults.
import type { ApiGraph } from "./convert.ts";
import type { ModelSource, Preset } from "./presets.ts";
import kleinStyle from "./setups/flux2-klein-4b-style.json" with { type: "json" };
import moss from "./setups/moss-image.json" with { type: "json" };
import fileSources from "./setups/files.json" with { type: "json" };

const GIB = 1024 ** 3;
const FILES: Readonly<Record<string, ModelSource>> = fileSources;

export type Level = "16" | "12" | "8" | "6" | "4" | "cpu";
export const GPU_LEVELS = [16, 12, 8, 6, 4] as const;

/** The level a card of `room` bytes runs at (imageRoom): unknown is the top level; under 4 GB on a GPU there is none. */
export function levelOf(room: number | undefined): Level | undefined {
  if (room === undefined) return "16";
  if (room === 0) return "cpu";
  const gib = GPU_LEVELS.find((g) => g * GIB <= room);
  return gib === undefined ? undefined : `${gib}`;
}

/** The styles, as the bench names them, and the picker's group for each (the web picker's Defaults rows follow `key`). */
export const STYLES = {
  general: { group: "General", word: "general", short: "General", prefix: "Natural editorial photograph, physically coherent objects, restrained colour, realistic light. " },
  portraits: { group: "Portraits and people", word: "portraits", short: "Faces", prefix: "Honest portrait photograph, natural skin texture, anatomically coherent hands and eyes, no glamour retouching. " },
  characters: { group: "Characters", word: "characters", short: "Heroes", prefix: "Finished character illustration with intentional shapes, coherent anatomy and clear silhouette. " },
  "pixel-art": { group: "Pixel art", word: "pixel art", short: "Retro pixel", prefix: "Deliberate pixel-art clusters, crisp grid-aligned edges, readable small forms, no smooth 3D rendering. " },
  sprites: { group: "Game sprites", word: "game sprites", short: "Sprites", prefix: "One complete game character, clear outer silhouette, all limbs and feet inside the frame, plain field, no scenery. " },
  backgrounds: { group: "Backgrounds", word: "backgrounds", short: "Backgrounds", prefix: "Production environment art, coherent spatial layout and readable large shapes, no UI or lettering. " },
  icons: { group: "Icons", word: "icons", short: "Icons", prefix: "Single centered icon with a bold readable silhouette and deliberate edges; no letters or decorative scenery. " },
  "text-logos": { group: "Text and logos", word: "text and logos", short: "Text", prefix: "Precise professional typography, only the exact requested words, balanced clear layout. " },
  painterly: { group: "Painterly and concept art", word: "painterly", short: "Painterly", prefix: "Intentional painterly image with clear focal design, coherent forms and controlled edges. " },
} as const;
export type Style = keyof typeof STYLES;

/**
 * The models a cell runs on. klein: FLUX.2 Klein 4B with the compact FP4 text encoder, which ran
 * under 4 GiB in the GPU matrix; klein-full: with the full encoder, under 8; moss: MOSS-Image
 * int8, under 4; cpu: Klein with the FP4 encoder and its weights kept in fp8 (the basic-PC
 * finalists). The memory is a cap the matrix ran under, never a measured peak.
 */
const MODELS = {
  klein: { name: "FLUX.2 Klein 4B compact", family: "flux", graph: kleinStyle, encoder: "qwen_3_4b_fp4_flux2.safetensors", gib: 4 },
  "klein-full": { name: "FLUX.2 Klein 4B", family: "flux", graph: kleinStyle, encoder: undefined, gib: 8 },
  moss: { name: "MOSS-Image", family: "moss", graph: moss, encoder: undefined, gib: 4 },
  cpu: { name: "FLUX.2 Klein 4B", where: " on the CPU", family: "flux", graph: kleinStyle, encoder: "qwen_3_4b_fp4_flux2.safetensors", gib: 4, dtype: "fp8_e4m3fn" },
} as const;

/** A node added after the decode, before the save, as the bench's graph has it. */
type Post = { readonly class_type: "ImageScale"; readonly inputs: { readonly upscale_method: string; readonly width: number; readonly height: number; readonly crop: "disabled" } }
  | { readonly class_type: "ImageQuantize"; readonly inputs: { readonly colors: number; readonly dither: string } };

interface Recipe {
  /** The bench's name for the approach, as its finalist files are labelled. */
  readonly approach: string;
  readonly style: Style;
  readonly levels: readonly Level[];
  readonly model: keyof typeof MODELS;
  readonly steps: number;
  /** Klein's guidance (1 by default) or MOSS-Image's (2.5 by default). */
  readonly cfg?: number;
  readonly size: readonly [number, number];
  /** Words after the style's own, before the person's. */
  readonly more?: string;
  /** The person's words alone: the official template's way, and the CPU finalists'. */
  readonly bare?: true;
  readonly post?: readonly Post[];
}

const scale = (method: string, width: number, height: number): Post => ({ class_type: "ImageScale", inputs: { upscale_method: method, width, height, crop: "disabled" } });
const CPU: readonly Level[] = ["cpu"];

// One row per approach that won at least one level, the levels it won (finalists/<style>/<level>.json).
const RECIPES: readonly Recipe[] = [
  { approach: "r2-2a-klein-compact8", style: "general", levels: ["16", "12"], model: "klein", steps: 12, cfg: 1.05, size: [896, 896], more: "Preserve the exact count and physical connections of every requested object. " },
  { approach: "fit-8b-klein-compact8", style: "general", levels: ["8", "6"], model: "klein", steps: 4, size: [512, 512] },
  { approach: "fit-4a-klein-compact8", style: "general", levels: ["4"], model: "klein", steps: 8, size: [512, 512] },
  { approach: "cpu-klein-fp4-768-2", style: "general", levels: CPU, model: "cpu", steps: 2, size: [768, 768], bare: true },

  { approach: "moss-official25", style: "portraits", levels: ["16", "12", "6", "4"], model: "moss", steps: 25, size: [768, 1024] },
  { approach: "fit-8a-klein-compact8", style: "portraits", levels: ["8"], model: "klein", steps: 8, size: [768, 1024] },
  { approach: "cpu-klein-fp4-2", style: "portraits", levels: CPU, model: "cpu", steps: 2, size: [512, 512], bare: true },

  { approach: "klein-official4", style: "characters", levels: ["16", "12"], model: "klein-full", steps: 4, size: [768, 1024], bare: true },
  { approach: "fit-8b-klein-compact8", style: "characters", levels: ["8"], model: "klein", steps: 4, size: [512, 672] },
  { approach: "moss-official25", style: "characters", levels: ["6", "4"], model: "moss", steps: 25, size: [768, 1024] },
  { approach: "cpu-klein-fp4-2", style: "characters", levels: CPU, model: "cpu", steps: 2, size: [512, 512], bare: true },

  { approach: "r2-1a-klein-compact8", style: "pixel-art", levels: ["16", "12", "8", "6", "4"], model: "klein", steps: 12, cfg: 1.05, size: [640, 640], more: "Edge-to-edge game art with a uniform pixel grid; respect the stated object counts. " },
  // drawn at 512, shrunk to 128 and cut to 256 colours, then shown at 512 with hard pixel edges
  {
    approach: "cpu-klein-pixel-128-256-4", style: "pixel-art", levels: CPU, model: "cpu", steps: 4, size: [512, 512], bare: true,
    post: [scale("area", 128, 128), { class_type: "ImageQuantize", inputs: { colors: 256, dither: "none" } }, scale("nearest-exact", 512, 512)],
  },

  { approach: "r2-1a-moss-official25", style: "sprites", levels: ["16", "12"], model: "moss", steps: 30, cfg: 2.7, size: [768, 768], more: "Show a readable face and separate limbs on a uniform magenta field. " },
  { approach: "fit-8b-klein-compact8", style: "sprites", levels: ["8"], model: "klein", steps: 4, size: [512, 512], post: [scale("nearest-exact", 768, 768)] },
  { approach: "moss-official25", style: "sprites", levels: ["6", "4"], model: "moss", steps: 25, size: [768, 768] },
  { approach: "cpu-klein-fp4-2", style: "sprites", levels: CPU, model: "cpu", steps: 2, size: [512, 512], bare: true },

  { approach: "r2-1b-moss-official25", style: "backgrounds", levels: ["16", "12", "6", "4"], model: "moss", steps: 20, cfg: 2.2, size: [1344, 768], more: "Keep the specified projection and clear traversable routes. " },
  { approach: "fit-8b-klein-compact8", style: "backgrounds", levels: ["8"], model: "klein", steps: 4, size: [896, 512] },
  { approach: "cpu-klein-fp4-2", style: "backgrounds", levels: CPU, model: "cpu", steps: 2, size: [768, 432], bare: true },

  { approach: "r2-2a-moss-official25", style: "icons", levels: ["16", "12"], model: "moss", steps: 30, cfg: 2.7, size: [768, 768], more: "Respect the exact stated geometric counts and preserve a simple small silhouette. " },
  { approach: "fit-8a-klein-compact8", style: "icons", levels: ["8"], model: "klein", steps: 8, size: [768, 768] },
  { approach: "moss-official25", style: "icons", levels: ["6", "4"], model: "moss", steps: 25, size: [768, 768] },
  { approach: "cpu-klein-fp4-2", style: "icons", levels: CPU, model: "cpu", steps: 2, size: [512, 512], bare: true },

  { approach: "moss-official25", style: "text-logos", levels: ["16", "12"], model: "moss", steps: 25, size: [1024, 1024] },
  { approach: "fit-8a-klein-compact12", style: "text-logos", levels: ["8"], model: "klein", steps: 8, size: [768, 768] },
  { approach: "r2-1a-moss-official25", style: "text-logos", levels: ["6", "4"], model: "moss", steps: 30, cfg: 2.7, size: [1024, 1024], more: "Render every requested letter exactly once; follow the requested line layout. " },
  // four steps, not the finalist's two: both two-step pictures misspelled a word, and the four-step one
  // spelled all three right (the bench's coordinator correction of 2026-11-13 supersedes the finalist)
  { approach: "cpu-klein-fp4-4", style: "text-logos", levels: CPU, model: "cpu", steps: 4, size: [512, 512], bare: true },

  { approach: "r2-2a-moss-official25", style: "painterly", levels: ["16", "12", "6"], model: "moss", steps: 30, cfg: 2.7, size: [1024, 1024], more: "Keep the specified painting medium obvious in the visible marks. " },
  { approach: "klein-full8", style: "painterly", levels: ["8"], model: "klein-full", steps: 8, size: [1024, 1024] },
  { approach: "fit-4b-klein-compact8", style: "painterly", levels: ["4"], model: "klein", steps: 4, size: [384, 384] },
  { approach: "cpu-klein-fp4-2", style: "painterly", levels: CPU, model: "cpu", steps: 2, size: [512, 512], bare: true },
];

const nodesOf = (graph: ApiGraph, cls: string) => Object.values(graph).filter((n) => n.class_type === cls);

/**
 * One of the app's graphs as a recipe runs it: the encoder and weight type, the steps, the
 * guidance and the size written in, and the post nodes chained between the decode and the save.
 */
export function tune(base: unknown, r: Pick<Recipe, "steps" | "cfg" | "size" | "post"> & { encoder?: string; dtype?: string }): ApiGraph {
  const graph = structuredClone(base) as ApiGraph;
  const [width, height] = r.size;
  for (const n of nodesOf(graph, "CLIPLoader")) if (r.encoder !== undefined) n.inputs["clip_name"] = r.encoder;
  for (const n of nodesOf(graph, "UNETLoader")) if (r.dtype !== undefined) n.inputs["weight_dtype"] = r.dtype;
  for (const n of [...nodesOf(graph, "Flux2Scheduler"), ...nodesOf(graph, "KSampler")]) n.inputs["steps"] = r.steps;
  for (const n of [...nodesOf(graph, "CFGGuider"), ...nodesOf(graph, "KSampler")]) if (r.cfg !== undefined) n.inputs["cfg"] = r.cfg;
  for (const n of [...nodesOf(graph, "EmptyFlux2LatentImage"), ...nodesOf(graph, "Flux2Scheduler")]) Object.assign(n.inputs, { width, height });
  const save = nodesOf(graph, "SaveImage")[0]!;
  let from = save.inputs["images"];
  (r.post ?? []).forEach((p, i) => {
    const id = `post:${i + 1}`;
    graph[id] = { class_type: p.class_type, inputs: { image: from, ...p.inputs } };
    from = [id, 0];
  });
  save.inputs["images"] = from;
  return graph;
}

/** A Defaults cell: a setup the picker lists only at its levels, under its style. */
export type StyleCell = Preset & { readonly style: Style; readonly levels: readonly Level[] };

export const STYLE_CELLS: readonly StyleCell[] = RECIPES.map((r) => {
  const model = MODELS[r.model];
  const style = STYLES[r.style];
  const [width, height] = r.size;
  return {
    id: `${r.style}--${r.approach}`,
    name: `${model.name} ${style.word}${"where" in model ? model.where : ""}`,
    short: style.short,
    family: model.family,
    group: style.group,
    style: r.style,
    levels: r.levels,
    workflow: tune(model.graph, { ...r, encoder: model.encoder, dtype: "dtype" in model ? model.dtype : undefined }),
    sizes: [{ width, height, bytes: model.gib * GIB }],
    measured: false,
    sources: FILES,
    ...r.bare ? {} : { wrap: { prefix: `${style.prefix}${r.more ?? ""}`, suffix: "" } },
  };
});

/** The cells the picker lists at this level, in the styles' order. */
export const cellsFor = (level: Level | undefined): StyleCell[] => level === undefined ? [] : STYLE_CELLS.filter((c) => c.levels.includes(level));
