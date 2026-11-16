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

describe("a switch set in the file passes on the input it selects", () => {
  type Node = { id: number; type: string; mode: number; inputs: { name: string; type: string; link: number | null; widget?: { name: string } }[]; outputs: { name: string; type: string; links: number[] }[]; properties: object; widgets_values?: unknown[] };
  // the checkpoint's MODEL reaches the sampler through a switch: off, the model itself; on, a patch of a class ComfyUI does not list
  const switched = (on: boolean) => {
    const workflow = sdxl() as unknown as { nodes: Node[]; links: unknown[][] };
    workflow.links = workflow.links.map((l) => l[0] === 38 ? [38, 91, 0, 12, 0, "MODEL"] : l);
    workflow.links.push([92, 15, 0, 91, 1, "MODEL"], [93, 90, 0, 91, 2, "MODEL"], [94, 15, 0, 90, 0, "MODEL"]);
    workflow.nodes.push(
      { id: 90, type: "SomePatch", mode: 0, inputs: [{ name: "model", type: "MODEL", link: 94 }], outputs: [{ name: "MODEL", type: "MODEL", links: [93] }], properties: {} },
      { id: 91, type: "ComfySwitchNode", mode: 0, inputs: [{ name: "switch", type: "BOOLEAN", widget: { name: "switch" }, link: null }, { name: "on_false", type: "*", link: 92 }, { name: "on_true", type: "*", link: 93 }], outputs: [{ name: "output", type: "*", links: [38] }], properties: {}, widgets_values: [on] },
    );
    return workflow;
  };

  it("off: the branch it does not take needs neither its node classes nor its files", () => {
    expect(convertWorkflow(switched(false), info)).toEqual(fixture("api/image_sdxl_simple.json"));
  });

  it("on: the branch it takes is converted, and refused by name when ComfyUI lacks its class", () => {
    expect(refusal(() => convertWorkflow(switched(true), info))).toBe("Needs a node this ComfyUI does not have: SomePatch (a custom node, or one from a newer ComfyUI).");
  });
});

const setup = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../src/image/setups/${name}`, import.meta.url), "utf8"));
// The edits setups/README.md lists, and no others: the app's own output prefix, and for MOSS the
// prompt enhancer off (its switch, and its branch muted), the size its own (the resolution
// selector gone) and the full FLUX.2 VAE the GPU matrix ran in place of the small one.
const prefix = (graph: Record<string, { inputs: Record<string, unknown> }>, id: string) => { graph["9"]!.inputs["filename_prefix"] = `gates-local/${id}`; return graph; };

describe("the app's Z-Image int8 and MOSS-Image setups are ComfyUI's own templates, converted", () => {
  type Node = { id: number; mode: number; inputs: { name: string; link: number | null }[]; widgets_values: unknown[] };
  type Workflow = { nodes: Node[]; links: number[][]; definitions: { subgraphs: { nodes: Node[] }[] } };

  it("Z-Image Turbo int8", () => {
    const graph = convertWorkflow(fixture("templates/image_z_image_turbo_int8.json"), info);
    expect(prefix(graph, "z-image-int8")).toEqual(setup("z-image-turbo-int8.json"));
  });

  it("MOSS-Image", () => {
    const workflow = fixture("templates/image_moss_image_t2i.json") as Workflow;
    const instance = workflow.nodes.find((n) => n.id === 18)!;
    instance.widgets_values[1] = false;
    for (const n of workflow.definitions.subgraphs[0]!.nodes) if ([11, 13, 14].includes(n.id)) n.mode = 2;
    for (const i of instance.inputs) if (i.name === "width" || i.name === "height") i.link = null;
    workflow.nodes = workflow.nodes.filter((n) => n.id !== 19);
    workflow.links = workflow.links.filter((l) => l[0] !== 40 && l[0] !== 41);
    const graph = prefix(convertWorkflow(workflow, info), "moss-image");
    graph["18:3"]!.inputs["vae_name"] = "flux2-vae.safetensors";
    expect(graph).toEqual(setup("moss-image.json"));
  });
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
    // the LoRA switch, off on the instance: the model comes straight from its loader, and the LoRA loader is not sent
    expect(graph["58:44"]!.inputs["model"]).toEqual(["58:6", 0]);
    expect([graph["58:52"], graph["58:41"]]).toEqual([undefined, undefined]);
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

type UiNode = { id: number; type: string; mode: number; inputs: { name: string; type: string; link: number | null; widget?: { name: string } }[]; outputs: { name?: string; type: string; links: number[] }[]; properties: object; widgets_values?: unknown[] };
type UiWorkflow = { nodes: UiNode[]; links: unknown[]; definitions?: { subgraphs: unknown[] } };
const sdxlUi = () => sdxl() as unknown as UiWorkflow;
const sdxlApi = () => fixture("api/image_sdxl_simple.json") as Record<string, { class_type: string; inputs: Record<string, unknown> }>;

describe("editor parts the API never sees", () => {
  it("the editor's old text box (PrimitiveNode) is dropped and its text written into the prompt it feeds", () => {
    const workflow = sdxlUi();
    const prompt = workflow.nodes.find((n) => n.id === 10)!;
    prompt.inputs.push({ name: "text", type: "STRING", widget: { name: "text" }, link: 95 });
    workflow.nodes.push({ id: 90, type: "PrimitiveNode", mode: 0, inputs: [], outputs: [{ type: "STRING", links: [95] }], properties: {}, widgets_values: ["a fox in snow"] });
    workflow.links.push([95, 90, 0, 10, 1, "STRING"]);
    const expected = sdxlApi();
    expected["10"]!.inputs["text"] = "a fox in snow";
    expect(convertWorkflow(workflow, info)).toEqual(expected);
  });

  it("a colour setting this app cannot read is refused by name, not read shifted", () => {
    const colored = structuredClone(info) as Record<string, { input: Record<string, unknown>; input_order: Record<string, string[]> }>;
    colored["SaveImage"]!.input["optional"] = { tint: ["COLOR", { default: "#ffffff" }] };
    colored["SaveImage"]!.input_order["optional"] = ["tint"];
    expect(refusal(() => convertWorkflow(sdxl(), colored))).toBe("SaveImage has a setting this app cannot read yet: tint (COLOR).");
  });

  it("values saved on a node with no settings at all (a preview's shown text) are not read, and not refused", () => {
    const workflow = sdxlUi();
    workflow.nodes.find((n) => n.type === "VAEDecode")!.widgets_values = ["a preview's shown text", 3];
    expect(convertWorkflow(workflow, info)).toEqual(sdxlApi());
  });

  it("an upload combo's upload value is editor state: the file name is read, the next value is not taken for another input", () => {
    const workflow = sdxlUi();
    workflow.nodes.push(
      { id: 90, type: "LoadImage", mode: 0, inputs: [], outputs: [{ type: "IMAGE", links: [96] }, { type: "MASK", links: [] }], properties: {}, widgets_values: ["example.png", "image"] },
      { id: 91, type: "PreviewImage", mode: 0, inputs: [{ name: "images", type: "IMAGE", link: 96 }], outputs: [], properties: {} },
    );
    workflow.links.push([96, 90, 0, 91, 0, "IMAGE"]);
    expect(convertWorkflow(workflow, info)).toEqual({
      ...sdxlApi(),
      "90": { class_type: "LoadImage", inputs: { image: "example.png" } },
      "91": { class_type: "PreviewImage", inputs: { images: ["90", 0] } },
    });
  });
});

const asObject = (l: unknown[]) => ({ id: l[0], origin_id: l[1], origin_slot: l[2], target_id: l[3], target_slot: l[4], type: l[5] });
const asArray = (l: Record<string, unknown>) => [l["id"], l["origin_id"], l["origin_slot"], l["target_id"], l["target_slot"], l["type"]];

it("links are read as arrays or as objects, at the root and inside a subgraph alike", () => {
  const workflow = fixture("templates/subgraph-case.json") as { links: unknown[][]; definitions: { subgraphs: { links: Record<string, unknown>[] }[] } };
  const swapped = { ...workflow, links: workflow.links.map(asObject), definitions: { subgraphs: workflow.definitions.subgraphs.map((s) => ({ ...s, links: s.links.map(asArray) })) } };
  expect(convertWorkflow(swapped, info)).toEqual(fixture("api/subgraph-case.json"));
});

describe("a switch whose setting is not fixed by its own value", () => {
  it("a switch set by another node's output stays a node, with both branches it may take", () => {
    const workflow = sdxlUi();
    workflow.links = workflow.links.map((l) => (l as unknown[])[0] === 38 ? [38, 91, 0, 12, 0, "MODEL"] : l);
    workflow.links.push([92, 15, 0, 91, 1, "MODEL"], [93, 15, 0, 91, 2, "MODEL"], [96, 95, 0, 91, 0, "INT"]);
    workflow.nodes.push(
      { id: 95, type: "PrimitiveInt", mode: 0, inputs: [], outputs: [{ type: "INT", links: [96] }], properties: {}, widgets_values: [1] },
      { id: 91, type: "ComfySwitchNode", mode: 0, inputs: [{ name: "switch", type: "BOOLEAN", widget: { name: "switch" }, link: 96 }, { name: "on_false", type: "*", link: 92 }, { name: "on_true", type: "*", link: 93 }], outputs: [{ type: "*", links: [38] }], properties: {}, widgets_values: [false] },
    );
    const expected = sdxlApi();
    expected["12"]!.inputs["model"] = ["91", 0];
    expect(convertWorkflow(workflow, info)).toEqual({
      ...expected,
      "91": { class_type: "ComfySwitchNode", inputs: { switch: ["95", 0], on_false: ["15", 0], on_true: ["15", 0] } },
      "95": { class_type: "PrimitiveInt", inputs: { value: 1 } },
    });
  });

  it("a switch inside a subgraph set on its instance (proxyWidgets) takes the instance's setting over its own", () => {
    const workflow = sdxlUi();
    workflow.links = workflow.links.map((l) => (l as unknown[])[0] === 38 ? [38, 91, 0, 12, 0, "MODEL"] : l);
    workflow.links.push([92, 15, 0, 91, 0, "MODEL"]);
    workflow.nodes.push({ id: 91, type: "model-switch", mode: 0, inputs: [{ name: "model", type: "MODEL", link: 92 }], outputs: [{ type: "MODEL", links: [38] }], properties: { proxyWidgets: [["5", "switch"]] }, widgets_values: [false] });
    workflow.definitions = { subgraphs: [{
      id: "model-switch", name: "Model switch",
      inputs: [{ name: "model", type: "MODEL" }],
      outputs: [{ linkIds: [3] }],
      nodes: [
        { id: 5, type: "ComfySwitchNode", mode: 0, inputs: [{ name: "switch", type: "BOOLEAN", widget: { name: "switch" }, link: null }, { name: "on_false", type: "*", link: 1 }, { name: "on_true", type: "*", link: 2 }], outputs: [{ type: "*", links: [3] }], properties: {}, widgets_values: [true] },
        { id: 6, type: "SomePatch", mode: 0, inputs: [{ name: "model", type: "MODEL", link: 4 }], outputs: [{ type: "MODEL", links: [2] }], properties: {} },
      ],
      links: [
        { id: 1, origin_id: -10, origin_slot: 0, target_id: 5, target_slot: 1, type: "MODEL" },
        { id: 2, origin_id: 6, origin_slot: 0, target_id: 5, target_slot: 2, type: "MODEL" },
        { id: 3, origin_id: 5, origin_slot: 0, target_id: -20, target_slot: 0, type: "MODEL" },
        { id: 4, origin_id: -10, origin_slot: 0, target_id: 6, target_slot: 0, type: "MODEL" },
      ],
    }] };
    expect(convertWorkflow(workflow, info)).toEqual(sdxlApi());
  });
});
