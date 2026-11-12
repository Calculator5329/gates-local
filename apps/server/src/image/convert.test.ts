// The converter from ComfyUI's saved-workflow format (nodes and links, with subgraphs) to the API
// format /prompt runs. Each fixture's expected graph in test/comfy/api was written by hand from
// the workflow file and /object_info (test/comfy/README.md says how), not exported from ComfyUI.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { convertWorkflow, WorkflowRefusal, type ObjectInfo } from "./convert.ts";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../test/comfy/${name}`, import.meta.url), "utf8"));
const info = fixture("object-info.json") as ObjectInfo;

describe.each([
  "image_flux2_klein_text_to_image",
  "image_sdxl_simple",
  "image_z_image_turbo",
  "subgraph-case",
])("%s", (name) => {
  it("converts to the API graph written for it", () => {
    expect(convertWorkflow(fixture(`templates/${name}.json`), info)).toEqual(fixture(`api/${name}.json`));
  });
});

const sdxl = () => fixture("templates/image_sdxl_simple.json") as { nodes: { id: number; type: string; mode?: number; widgets_values?: unknown[] }[] };
const refusal = (run: () => unknown) => {
  try { run(); }
  catch (error) { if (error instanceof WorkflowRefusal) return error.message; throw error; }
  throw new Error("not refused");
};

it("a node class ComfyUI does not list is refused by name, once", () => {
  const workflow = sdxl();
  for (const node of workflow.nodes) if (node.type === "CLIPTextEncode") node.type = "SuperPromptPlus";
  expect(refusal(() => convertWorkflow(workflow, info))).toBe("Needs a node this ComfyUI does not have: SuperPromptPlus (a custom node, or one from a newer ComfyUI).");
});

it("a node class missing only on a muted branch is no reason to refuse", () => {
  const workflow = fixture("templates/subgraph-case.json") as { nodes: { id: number; type: string }[] };
  workflow.nodes.find((n) => n.id === 34)!.type = "SomeCustomPreview";
  expect(convertWorkflow(workflow, info)).toEqual(fixture("api/subgraph-case.json"));
});

it("widget values that do not line up with ComfyUI's inputs are refused, never sent shifted", () => {
  const workflow = sdxl();
  const sampler = workflow.nodes.find((n) => n.type === "KSampler")!;
  sampler.widgets_values = [812045847300606, "randomize", 7, "dpmpp_2m", "karras", 1]; // steps left out
  expect(refusal(() => convertWorkflow(workflow, info))).toBe("KSampler's saved values do not match the inputs ComfyUI lists for it (cfg).");
});

it("an API-format file passes through as it is", () => {
  const api = fixture("api/image_sdxl_simple.json");
  expect(convertWorkflow(api, info)).toEqual(api);
});

it("an API-format file with a node class ComfyUI does not list is refused the same way", () => {
  const api = fixture("api/image_sdxl_simple.json") as Record<string, { class_type: string }>;
  api["10"]!.class_type = "SuperPromptPlus";
  expect(refusal(() => convertWorkflow(api, info))).toBe("Needs a node this ComfyUI does not have: SuperPromptPlus (a custom node, or one from a newer ComfyUI).");
});

it("a file that is neither format is refused", () => {
  expect(refusal(() => convertWorkflow({ hello: "world" }, info))).toBe("Not a ComfyUI workflow.");
});

it("a workflow with no output node is refused", () => {
  const workflow = sdxl();
  workflow.nodes = workflow.nodes.filter((n) => n.type !== "SaveImage");
  expect(refusal(() => convertWorkflow(workflow, info))).toBe("Saves no image: it has no output node.");
});

it("values left over after every input has one are refused, never dropped", () => {
  const workflow = sdxl();
  workflow.nodes.find((n) => n.type === "KSampler")!.widgets_values!.push(0.5);
  expect(refusal(() => convertWorkflow(workflow, info))).toBe("KSampler's saved values do not match the inputs ComfyUI lists for it (1 left over).");
});

it("a widget of a kind this app cannot read (a dynamic combo) is refused by name, not read shifted", () => {
  const workflow = sdxl();
  const save = workflow.nodes.find((n) => n.type === "SaveImage")!;
  save.type = "SaveImageAdvanced";
  save.widgets_values = ["ComfyUI", "png", "8-bit", "sRGB"];
  expect(refusal(() => convertWorkflow(workflow, info))).toBe("SaveImageAdvanced has a setting this app cannot read yet: format (COMFY_DYNAMICCOMBO_V3).");
});

it("an output node of a class ComfyUI does not list is named, even beside one it does", () => {
  type Node = { id: number; type: string; mode: number; inputs: { name: string; type: string; link: number }[]; outputs: unknown[]; properties: object; widgets_values: unknown[] };
  const workflow = sdxl() as unknown as { nodes: Node[]; links: unknown[][] };
  workflow.links.push([90, 14, 0, 90, 0, "IMAGE"]);
  workflow.nodes.push({ id: 90, type: "SaveImageWebp", mode: 0, inputs: [{ name: "images", type: "IMAGE", link: 90 }], outputs: [], properties: {}, widgets_values: ["ComfyUI"] });
  expect(refusal(() => convertWorkflow(workflow, info))).toBe("Needs a node this ComfyUI does not have: SaveImageWebp (a custom node, or one from a newer ComfyUI).");
});

it("a bypassed node passes on the input of its output's type, not the one in the same place", () => {
  type Node = { id: number; type: string; mode: number; inputs: { name: string; type: string; link: number }[]; outputs: { name: string; type: string; links: number[] }[]; properties: object };
  const workflow = sdxl() as unknown as { nodes: Node[]; links: unknown[][] };
  // the checkpoint's MODEL reaches the sampler through a bypassed patch whose first input is a CLIP
  workflow.links = workflow.links.map((l) => l[0] === 38 ? [38, 90, 0, 12, 0, "MODEL"] : l);
  workflow.links.push([91, 15, 1, 90, 0, "CLIP"], [92, 15, 0, 90, 1, "MODEL"]);
  workflow.nodes.push({ id: 90, type: "SomePatch", mode: 4, inputs: [{ name: "clip", type: "CLIP", link: 91 }, { name: "model", type: "MODEL", link: 92 }], outputs: [{ name: "MODEL", type: "MODEL", links: [38] }], properties: {} });
  expect(convertWorkflow(workflow, info)).toEqual(fixture("api/image_sdxl_simple.json"));
});

describe("values set on a subgraph instance win over the inner node's own", () => {
  type Instance = { id: number; widgets_values: unknown[] };
  const minimax = () => fixture("templates/image_minimax_h3_t2i.json") as { nodes: Instance[] };
  const prompt = (minimax().nodes.find((n) => n.id === 58)!.widgets_values[0] as string);

  // ComfyUI's own MiniMax H3 template, from before `proxyWidgets`: the instance holds 30 steps and
  // its own prompt and seed, the inner nodes 8 steps, a red panda and seed 0.
  it("in the older format, one value for each input the instance shows as a widget, in order", () => {
    const graph = convertWorkflow(minimax(), info);
    expect(graph["58:9"]).toEqual({ class_type: "BasicScheduler", inputs: { scheduler: "simple", steps: 30, denoise: 1, model: ["58:44", 0] } });
    expect(graph["58:15"]).toEqual({ class_type: "RandomNoise", inputs: { noise_seed: 697447143149280 } });
    expect(graph["58:12"]!.inputs["text"]).toBe(prompt);
    expect(graph["58:52"]!.inputs["switch"]).toBe(false);
    expect(graph["58:17"]!.inputs["sampler_name"]).toBe("res_multistep");
    expect(graph["58:44"]!.inputs["attention"]).toBe("comfy kitchen attention");
    // a widget socket with a link takes the link: the size comes from the selector
    expect(graph["58:46"]!.inputs).toMatchObject({ width: ["79", 0], height: ["79", 1] });
  });

  it("in the older format, a seed's control word is skipped, not read as the next value", () => {
    const workflow = minimax();
    workflow.nodes.find((n) => n.id === 58)!.widgets_values.splice(6, 0, "fixed");
    const graph = convertWorkflow(workflow, info);
    expect(graph["58:15"]!.inputs["noise_seed"]).toBe(697447143149280);
    expect(graph["58:17"]!.inputs["sampler_name"]).toBe("res_multistep");
  });

  it.each([
    [(v: unknown[]) => v.pop(), "no value for attention"],
    [(v: unknown[]) => v.push("extra"), "1 left over"],
    [(v: unknown[]) => { v[4] = "30"; }, "steps"],
  ])("in the older format, values that do not line up are refused (%#)", (change, why) => {
    const workflow = minimax();
    change(workflow.nodes.find((n) => n.id === 58)!.widgets_values);
    expect(refusal(() => convertWorkflow(workflow, info))).toBe(`Text to Image (MiniMax H3)'s saved values do not match its inputs (${why}).`);
  });

  it("in the newer format, each value goes to the inner widget its proxyWidgets entry names", () => {
    const workflow = fixture("templates/image_z_image_turbo.json") as { nodes: Instance[] };
    workflow.nodes.find((n) => n.id === 57)!.widgets_values = ["a fox", 640, 512, 42, 5, "z.safetensors", "q.safetensors", "v.safetensors", "fixed"];
    const graph = convertWorkflow(workflow, info);
    expect(graph["57:27"]!.inputs["text"]).toBe("a fox");
    expect(graph["57:13"]!.inputs).toMatchObject({ width: 640, height: 512 });
    expect(graph["57:3"]!.inputs).toMatchObject({ seed: 42, steps: 5 });
    expect([graph["57:28"]!.inputs["unet_name"], graph["57:30"]!.inputs["clip_name"], graph["57:29"]!.inputs["vae_name"]]).toEqual(["z.safetensors", "q.safetensors", "v.safetensors"]);
  });
});
