// Finding a workflow's prompt, size, seed and output by the shape of its graph, and refusing one
// where any of them is missing, doubled or worked out by another node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyControls, findControls } from "./controls.ts";
import { WorkflowRefusal, type ApiGraph } from "./convert.ts";
import klein from "./setups/flux2-klein-4b.json" with { type: "json" };
import compact from "./setups/flux2-klein-4b-compact.json" with { type: "json" };
import moss from "./setups/moss-image.json" with { type: "json" };
import zImage from "./setups/z-image-turbo-int8.json" with { type: "json" };

const api = (name: string): ApiGraph => JSON.parse(readFileSync(new URL(`../../test/comfy/api/${name}.json`, import.meta.url), "utf8")) as ApiGraph;
const refusal = (graph: ApiGraph) => {
  try { findControls(graph); }
  catch (error) { if (error instanceof WorkflowRefusal) return error.message; throw error; }
  throw new Error("not refused");
};

describe("ComfyUI's own templates", () => {
  it("Klein: the text box inside the subgraph, the two size numbers both the latent and the scheduler read, the noise seed", () => {
    expect(findControls(api("image_flux2_klein_text_to_image"))).toEqual({
      prompt: { node: "75:74", input: "text" },
      width: [{ node: "75:68", input: "value" }],
      height: [{ node: "75:69", input: "value" }],
      seed: { node: "75:73", input: "noise_seed" },
      latent: "75:66",
      output: "9",
      size: { width: 1024, height: 1024 },
    });
  });

  it("SDXL: the positive text, the empty latent, the sampler's seed", () => {
    expect(findControls(api("image_sdxl_simple"))).toEqual({
      prompt: { node: "10", input: "text" },
      width: [{ node: "13", input: "width" }],
      height: [{ node: "13", input: "height" }],
      seed: { node: "12", input: "seed" },
      latent: "13",
      output: "7",
      size: { width: 1024, height: 1024 },
    });
  });

  it("Z-Image: the negative made from the positive (ConditioningZeroOut) is not a second prompt", () => {
    expect(findControls(api("image_z_image_turbo"))).toMatchObject({ prompt: { node: "57:27", input: "text" }, seed: { node: "57:3", input: "seed" }, output: "9" });
  });
});

describe("the app's own setups", () => {
  it("Klein: a scheduler that repeats the latent's size keeps in step with it", () => {
    const controls = findControls(klein as ApiGraph);
    expect(controls.width).toEqual([{ node: "10", input: "width" }, { node: "9", input: "width" }]);
    expect(controls.height).toEqual([{ node: "10", input: "height" }, { node: "9", input: "height" }]);
    const graph = applyControls(klein as ApiGraph, controls, { prompt: "a lighthouse", width: 768, height: 1024, seed: 7 });
    expect(graph["4"]!.inputs["text"]).toBe("a lighthouse");
    expect(graph["9"]!.inputs).toEqual({ steps: 8, width: 768, height: 1024 });
    expect(graph["10"]!.inputs).toEqual({ width: 768, height: 1024, batch_size: 1 });
    expect(graph["7"]!.inputs["noise_seed"]).toBe(7);
    expect((klein as ApiGraph)["4"]!.inputs["text"]).toBe("a red fox asleep in fresh snow"); // the file's own graph is left as it was
  });

  it("MOSS-Image: only the prompt, size and seed change; its written negative stays", () => {
    const graph = applyControls(moss as ApiGraph, findControls(moss as ApiGraph), { prompt: "a tree", width: 768, height: 1024, seed: 42 });
    const expected = structuredClone(moss as ApiGraph);
    expected["18:4"]!.inputs["text"] = "a tree";
    Object.assign(expected["18:6"]!.inputs, { width: 768, height: 1024 });
    expected["18:7"]!.inputs["seed"] = 42;
    expect(graph).toEqual(expected);
  });

  it("Z-Image Turbo int8 and Klein compact: the prompt and seed are found where their templates put them", () => {
    expect(findControls(zImage as ApiGraph)).toMatchObject({ prompt: { node: "57:27", input: "text" }, seed: { node: "57:3", input: "seed" }, latent: "57:13", output: "9" });
    expect(findControls(compact as ApiGraph)).toMatchObject({ prompt: { node: "4", input: "text" }, seed: { node: "7", input: "noise_seed" }, latent: "10" });
  });

  it("a batch of four in the file still runs one picture", () => {
    const graph = structuredClone(api("image_sdxl_simple"));
    graph["13"]!.inputs["batch_size"] = 4;
    expect(applyControls(graph, findControls(graph), { prompt: "a", width: 1024, height: 1024, seed: 1 })["13"]!.inputs["batch_size"]).toBe(1);
  });
});

const sdxl = () => structuredClone(api("image_sdxl_simple"));
describe("refusals, in words for the picker", () => {

  it("two pictures saved", () => {
    const graph = sdxl();
    graph["8"] = { class_type: "PreviewImage", inputs: { images: ["14", 0] } };
    expect(refusal(graph)).toBe("It saves 2 pictures (nodes 7 and 8); Image mode takes one.");
  });

  it("no picture saved", () => {
    const graph = sdxl();
    delete graph["7"];
    expect(refusal(graph)).toBe("It saves no picture: there is no Save Image or Preview Image node.");
  });

  it("two prompts", () => {
    const graph = sdxl();
    graph["20"] = { class_type: "CLIPTextEncode", inputs: { text: "second", clip: ["15", 1] } };
    graph["21"] = { class_type: "KSampler", inputs: { ...graph["12"]!.inputs, positive: ["20", 0] } };
    expect(refusal(graph)).toBe("It has 2 prompt boxes (nodes 10 and 20); Image mode fills in one.");
  });

  it("a prompt worked out by another node", () => {
    const graph = sdxl();
    graph["20"] = { class_type: "StringConcatenate", inputs: { string_a: "a", string_b: "b", delimiter: "" } };
    graph["10"]!.inputs["text"] = ["20", 0];
    expect(refusal(graph)).toBe("Its prompt is made by another node (StringConcatenate), so Image mode cannot fill it in.");
  });

  it("no empty latent to size", () => {
    const graph = sdxl();
    graph["13"]!.class_type = "LatentUpscale";
    expect(refusal(graph)).toBe("It has no empty latent node, so Image mode cannot set the picture's size.");
  });

  it("a size worked out by another node", () => {
    const graph = sdxl();
    graph["20"] = { class_type: "GetImageSize", inputs: {} };
    graph["13"]!.inputs["width"] = ["20", 0];
    expect(refusal(graph)).toBe("Its size is made by another node (GetImageSize), so Image mode cannot set it.");
  });

  it("two seeds", () => {
    const graph = sdxl();
    graph["21"] = { class_type: "KSampler", inputs: { ...graph["12"]!.inputs, seed: 5 } };
    expect(refusal(graph)).toBe("It has 2 seeds (nodes 12 and 21); Image mode sets one.");
  });

  it("no seed", () => {
    const graph = sdxl();
    delete graph["12"]!.inputs["seed"];
    expect(refusal(graph)).toBe("It has no seed, so every picture would come out the same.");
  });

  it("a picture to start from", () => {
    const graph = sdxl();
    graph["20"] = { class_type: "LoadImage", inputs: { image: "example.png" } };
    graph["21"] = { class_type: "VAEEncode", inputs: { pixels: ["20", 0], vae: ["15", 2] } };
    graph["12"]!.inputs["latent_image"] = ["21", 0];
    expect(refusal(graph)).toBe("It starts from a picture (Load Image); Image mode makes pictures from words only.");
  });
});
