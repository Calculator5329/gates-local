import { describe, expect, it } from "vitest";
import { comfyInfo, KLEIN_COMPACT_FILES, KLEIN_FILES, MOSS_FILES } from "../../test/comfy/info.ts";
import type { ApiGraph, ApiNode } from "./convert.ts";
import { jobGraph } from "./presets.ts";
import { cellsFor, compactStandIn, STYLE_CELLS, type StyleCell } from "./styles.ts";

const PROMPT = "a red fox in snow";
const info = comfyInfo(KLEIN_FILES, KLEIN_COMPACT_FILES, MOSS_FILES);
const cell = (id: string): StyleCell => STYLE_CELLS.find((c) => c.id === id)!;
const sent = (c: StyleCell): ApiGraph => jobGraph(c, info, { prompt: PROMPT, seed: 1, width: c.sizes[0]!.width, height: c.sizes[0]!.height });
const inputsOf = (graph: ApiGraph, cls: string): Record<string, unknown>[] => Object.values(graph).filter((n) => n.class_type === cls).map((n) => n.inputs);
const promptText = (graph: ApiGraph): unknown[] => Object.values(graph).map((n) => n.inputs["text"]).filter((t) => typeof t === "string" && t.includes(PROMPT));

function afterDecode(graph: ApiGraph): ApiNode[] {
  const save = Object.values(graph).find((n) => n.class_type === "SaveImage")!;
  const out: ApiNode[] = [];
  let link = save.inputs["images"];
  while (Array.isArray(link)) {
    const node = graph[String(link[0])]!;
    out.unshift(node);
    if (node.class_type === "VAEDecode") break;
    link = node.inputs["image"];
  }
  return out;
}

describe("a Defaults cell as the style bench ran it", () => {
  it("runs its encoder, weights, steps, guidance and size in every node that takes them", () => {
    const general = sent(cell("general--r2-2a-klein-compact8"));
    expect(inputsOf(general, "CLIPLoader")).toMatchObject([{ clip_name: "qwen_3_4b_fp4_flux2.safetensors" }]);
    expect(inputsOf(general, "UNETLoader")).toMatchObject([{ weight_dtype: "default" }]);
    expect(inputsOf(general, "Flux2Scheduler")).toMatchObject([{ steps: 12, width: 896, height: 896 }]);
    expect(inputsOf(general, "EmptyFlux2LatentImage")).toMatchObject([{ width: 896, height: 896 }]);
    expect(inputsOf(general, "CFGGuider")).toMatchObject([{ cfg: 1.05 }]);
    const cpu = sent(cell("general--cpu-klein-fp4-768-2"));
    expect(inputsOf(cpu, "UNETLoader")).toMatchObject([{ weight_dtype: "fp8_e4m3fn" }]);
    expect(inputsOf(cpu, "Flux2Scheduler")).toMatchObject([{ steps: 2, width: 768, height: 768 }]);
    const backgrounds = sent(cell("backgrounds--r2-1b-moss-official25"));
    expect(inputsOf(backgrounds, "KSampler")).toMatchObject([{ steps: 20, cfg: 2.2 }]);
    expect(inputsOf(backgrounds, "EmptyFlux2LatentImage")).toMatchObject([{ width: 1344, height: 768 }]);
  });

  it("a cell that sets no guidance runs its model's own: 1 on Klein, 2.5 on MOSS-Image", () => {
    expect(inputsOf(sent(cell("general--fit-8b-klein-compact8")), "CFGGuider")).toMatchObject([{ cfg: 1 }]);
    expect(inputsOf(sent(cell("portraits--moss-official25")), "KSampler")).toMatchObject([{ cfg: 2.5 }]);
  });

  it("writes the style's words, then the cell's own, before the person's", () => {
    expect(promptText(sent(cell("general--r2-2a-klein-compact8")))).toEqual([
      `Natural editorial photograph, physically coherent objects, restrained colour, realistic light. Preserve the exact count and physical connections of every requested object. ${PROMPT}`,
    ]);
    expect(promptText(sent(cell("general--fit-8b-klein-compact8")))).toEqual([`Natural editorial photograph, physically coherent objects, restrained colour, realistic light. ${PROMPT}`]);
  });

  it("every CPU cell, and Characters on Klein's official settings, sends the person's words alone", () => {
    for (const c of [...cellsFor("cpu"), cell("characters--klein-official4")]) {
      expect(c.wrap, c.id).toBeUndefined();
      expect(promptText(sent(c)), c.id).toEqual([PROMPT]);
    }
  });

  it("runs its added nodes between the decode and the save, in the bench's order", () => {
    expect(afterDecode(sent(cell("general--fit-8b-klein-compact8"))).map((n) => n.class_type)).toEqual(["VAEDecode"]);
    expect(afterDecode(sent(cell("sprites--fit-8b-klein-compact8")))).toMatchObject([
      { class_type: "VAEDecode" },
      { class_type: "ImageScale", inputs: { upscale_method: "nearest-exact", width: 768, height: 768 } },
    ]);
  });

  it("the CPU pixel-art cell draws at 512, shrinks it to 128, cuts it to 256 colours and shows it at 512 with hard pixel edges", () => {
    const graph = sent(cell("pixel-art--cpu-klein-pixel-128-256-4"));
    expect(inputsOf(graph, "EmptyFlux2LatentImage")).toMatchObject([{ width: 512, height: 512 }]);
    expect(afterDecode(graph)).toMatchObject([
      { class_type: "VAEDecode" },
      { class_type: "ImageScale", inputs: { upscale_method: "area", width: 128, height: 128 } },
      { class_type: "ImageQuantize", inputs: { colors: 256, dither: "none" } },
      { class_type: "ImageScale", inputs: { upscale_method: "nearest-exact", width: 512, height: 512 } },
    ]);
  });

  it("every cell's memory is a cap the bench ran under, never measured, and every Klein cell shows one model name whichever encoder it runs", () => {
    expect(STYLE_CELLS.filter((c) => c.measured)).toEqual([]);
    expect(new Set(STYLE_CELLS.filter((c) => c.family === "flux").map((c) => c.model))).toEqual(new Set(["FLUX.2 Klein 4B"]));
    expect([cell("characters--klein-official4"), cell("painterly--klein-full8"), cell("general--r2-2a-klein-compact8"), cell("general--cpu-klein-fp4-768-2")].map((c) => c.model)).toEqual(Array.from({ length: 4 }, () => "FLUX.2 Klein 4B"));
    expect(new Set(STYLE_CELLS.filter((c) => c.family === "moss").map((c) => c.model))).toEqual(new Set(["MOSS-Image"]));
  });
});

describe("a style's stand-in for a winner that needs a second download", () => {
  it("is the style's compact Klein cell from the nearest level at or under the card's, else the nearest above", () => {
    const standIn = (id: string, level: Parameters<typeof compactStandIn>[1]) => compactStandIn(cell(id), level)?.id;
    expect(standIn("characters--klein-official4", "16")).toBe("characters--fit-8b-klein-compact8");
    expect(standIn("sprites--r2-1a-moss-official25", "12")).toBe("sprites--fit-8b-klein-compact8");
    expect(standIn("sprites--moss-official25", "6")).toBe("sprites--fit-8b-klein-compact8");
    const general = { ...cell("general--r2-2a-klein-compact8"), id: "general--needs-a-download" };
    expect(compactStandIn(general, "16")?.id).toBe("general--r2-2a-klein-compact8");
    expect(compactStandIn(general, "8")?.id).toBe("general--fit-8b-klein-compact8");
    expect(compactStandIn(general, "4")?.id).toBe("general--fit-4a-klein-compact8");
  });

  it("is none on the CPU, and none for a winner that is compact Klein already", () => {
    expect(compactStandIn(cell("portraits--moss-official25"), "cpu")).toBeUndefined();
    expect(compactStandIn(cell("characters--klein-official4"), "cpu")).toBeUndefined();
    expect(compactStandIn(cell("general--fit-8b-klein-compact8"), "8")).toBeUndefined();
  });
});
