// The app's setups judged against ComfyUI's lists: ready, needing files, or refused with the reason.
import { describe, expect, it } from "vitest";
import { comfyInfo, KLEIN_FILES, SDXL_FILES } from "../../test/comfy/info.ts";
import { readFileSync } from "node:fs";
import { imageFitVerdict } from "@gates-local/contracts";
import { comfyLists, defaultChoice, jobGraph, listPresets, presetFiles, PRESETS, resolveChoice, workflowPreset, type Preset } from "./presets.ts";
import { keepWorkflow } from "./sources.ts";

const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);
const template = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../test/comfy/templates/${name}.json`, import.meta.url), "utf8"));
const KLEIN_IDS = ["flux2-klein-4b", "flux2-klein-4b-portraits", "flux2-klein-4b-pixel", "flux2-klein-4b-sprites", "flux2-klein-4b-backgrounds"];

describe("listPresets", () => {
  it("lists a setup whose files ComfyUI does not name as needing them, by the names its workflow gives", () => {
    const { ready, others } = listPresets(comfyLists(comfyInfo(SDXL_FILES)));
    expect(ids(ready)).toEqual(["sdxl-lightning", "sdxl-lightning-pixel"]);
    expect(ids(others)).toEqual(KLEIN_IDS);
    // the sizes are the app's own record of each file (setups/files.json): 4.07 + 8.04 + 0.34 GB
    expect(others[0]).toMatchObject({ id: "flux2-klein-4b", needs: { files: ["flux-2-klein-4b-fp8.safetensors", "qwen_3_4b.safetensors", "flux2-vae.safetensors"], bytes: 12_451_817_860 } });
  });

  it("refuses a setup whose node class this ComfyUI does not list, and says which", () => {
    const info = comfyInfo(SDXL_FILES, KLEIN_FILES);
    delete info["Flux2Scheduler"];
    const { ready, others } = listPresets(comfyLists(info));
    expect(ids(ready)).toEqual(["sdxl-lightning", "sdxl-lightning-pixel"]);
    expect(ids(others)).toEqual(KLEIN_IDS);
    expect(others[0]).toMatchObject({ id: "flux2-klein-4b", why: "Needs a node this ComfyUI does not have: Flux2Scheduler (a custom node, or one from a newer ComfyUI)." });
  });

  it("a kept list from before node classes were kept judges files only", () => {
    const { files } = comfyLists(comfyInfo(SDXL_FILES, KLEIN_FILES));
    expect(ids(listPresets({ files }).ready)).toEqual(["flux2-klein-4b", "sdxl-lightning", "flux2-klein-4b-portraits", "flux2-klein-4b-pixel", "sdxl-lightning-pixel", "flux2-klein-4b-sprites", "flux2-klein-4b-backgrounds"]);
  });
});

describe("jobGraph", () => {
  const pixel = resolveChoice({ preset: "sdxl-lightning-pixel", width: 768, height: 512 }).preset;

  it("names each file as ComfyUI lists it, subfolder included", () => {
    const graph = jobGraph(pixel, comfyInfo({ checkpoints: ["sdxl/sdxl_lightning_4step.safetensors"], loras: SDXL_FILES.loras }), { prompt: "a", seed: 1, width: 768, height: 512 });
    expect(graph["1"]!.inputs["ckpt_name"]).toBe("sdxl/sdxl_lightning_4step.safetensors");
  });

  it("a file ComfyUI does not list fails in words that name it", () => {
    const info = comfyInfo({ checkpoints: SDXL_FILES.checkpoints });
    expect(() => jobGraph(pixel, info, { prompt: "a", seed: 1, width: 768, height: 512 })).toThrow(expect.objectContaining({ code: "image-model", file: "RW_pixelart_XL_v1.safetensors" }));
  });

  it("the files a setup loads come from its workflow", () => {
    expect(presetFiles(pixel)).toEqual(["sdxl_lightning_4step.safetensors", "RW_pixelart_XL_v1.safetensors"]);
  });
});

// What the GPU matrix of 2026-11-12 ruled for the app's own setups (quality picks stay the owner's).
describe("the app's own setups, as measured", () => {
  const info = comfyInfo(SDXL_FILES, KLEIN_FILES);

  it("default to Klein 4B, then SDXL Lightning: never Z-Image or Stable Diffusion 1.5", () => {
    expect(defaultChoice(comfyLists(info))).toMatchObject({ preset: "flux2-klein-4b" });
    expect(defaultChoice(comfyLists(comfyInfo(SDXL_FILES)))).toMatchObject({ preset: "sdxl-lightning" });
    expect(PRESETS.map((p) => p.family).filter((f) => f === "zimage" || f === "sd15")).toEqual([]);
  });

  it("a Klein row is never offered under 10 GiB free: with its full text encoder it ran out of memory at 6", () => {
    for (const p of PRESETS.filter((x) => x.id.startsWith("flux2-klein-4b"))) {
      for (const size of p.sizes) {
        expect(size.bytes).toBe(10 * 1024 ** 3);
        expect(imageFitVerdict({ estimateBytes: size.bytes, freeBytes: 10 * 1024 ** 3 - 1, creditedBytes: 0 }).verdict).toBe("refuse");
      }
    }
  });

  it("with only Z-Image Turbo's files in ComfyUI, its template is not the default: Z-Image BF16 is never one", () => {
    const files = { diffusion_models: ["z_image_turbo_bf16.safetensors"], text_encoders: ["qwen_3_4b.safetensors"], vae: ["ae.safetensors"] };
    const zinfo = comfyInfo(files);
    const zimage = workflowPreset(keepWorkflow("template:image_z_image_turbo", "Z-Image Turbo", "ComfyUI templates", template("image_z_image_turbo"), zinfo));
    expect(ids(listPresets(comfyLists(zinfo), [zimage]).ready)).toEqual(["template:image_z_image_turbo"]);
    expect(defaultChoice(comfyLists(zinfo), [zimage])).toMatchObject({ preset: "flux2-klein-4b" });
    // another ready row is still the fallback
    const sdxl = workflowPreset(keepWorkflow("template:image_sdxl_simple", "SDXL", "ComfyUI templates", template("image_sdxl_simple"), zinfo));
    const both = comfyInfo(files, { checkpoints: ["sd_xl_base_1.0.safetensors"] });
    expect(defaultChoice(comfyLists(both), [zimage, sdxl])).toMatchObject({ preset: "template:image_sdxl_simple" });
  });
});

describe("themes", () => {
  const info = comfyInfo(SDXL_FILES, KLEIN_FILES);
  const values = { prompt: "a fox", seed: 1, width: 768, height: 768 };

  it("a theme writes its words around the person's prompt", () => {
    const graph = jobGraph(resolveChoice({ preset: "flux2-klein-4b-portraits", width: 832, height: 1216 }).preset, info, { ...values, width: 832, height: 1216 });
    expect(graph["4"]!.inputs["text"]).toBe("Natural editorial portrait photograph. a fox Soft window light, realistic skin texture, clear eyes, both hands visible with relaxed separated fingers, simple uncluttered background.");
  });

  it("pixel art is drawn at the size picked, then saved at 128 px in 32 colours", () => {
    const graph = jobGraph(resolveChoice({ preset: "flux2-klein-4b-pixel", width: 768, height: 768 }).preset, info, values);
    expect([graph["10"]!.inputs["width"], graph["10"]!.inputs["height"]]).toEqual([768, 768]);
    expect(graph["14"]!.inputs).toMatchObject({ width: 128, height: 128 });
    expect(graph["15"]!.inputs).toMatchObject({ colors: 32 });
    expect(graph["13"]!.inputs["images"]).toEqual(["15", 0]);
  });
});

describe("workflows ComfyUI has", () => {
  const info = comfyInfo(SDXL_FILES);
  const zimage = keepWorkflow("template:image_z_image_turbo", "Z-Image Turbo", "ComfyUI templates", template("image_z_image_turbo"), info);
  const sdxlTemplate = keepWorkflow("template:image_sdxl_simple", "SDXL", "ComfyUI templates", template("image_sdxl_simple"), info);
  const extra = [zimage, sdxlTemplate, { id: "saved:edit", name: "edit", group: "Your workflows", why: "It starts from a picture (Load Image); Image mode makes pictures from words only." }].map(workflowPreset);
  /** The SDXL template's row with these sources for its missing checkpoint: what it needs. */
  const needsWith = (sources: Preset["sources"]) => listPresets(comfyLists(info), [{ ...workflowPreset(sdxlTemplate), id: "t", sources }]).others.find((p) => p.id === "t")?.needs;

  it("come after the app's own, ready, needing files, or refused with the reason", () => {
    const { ready, others } = listPresets(comfyLists(info), extra);
    expect(ids(ready)).toEqual(["sdxl-lightning", "sdxl-lightning-pixel"]);
    expect(others.slice(KLEIN_IDS.length)).toEqual([
      expect.objectContaining({ id: "template:image_z_image_turbo", group: "ComfyUI templates", family: "zimage", needs: { files: ["qwen_3_4b.safetensors", "ae.safetensors", "z_image_turbo_bf16.safetensors"], download: true } }),
      expect.objectContaining({ id: "template:image_sdxl_simple", needs: { files: ["sd_xl_base_1.0.safetensors"], download: true } }),
      expect.objectContaining({ id: "saved:edit", why: "It starts from a picture (Load Image); Image mode makes pictures from words only." }),
    ]);
  });

  it("offer a download only when every missing file has a Hugging Face address and a folder", () => {
    const name = "sd_xl_base_1.0.safetensors", hf = "https://huggingface.co/stabilityai/sdxl/resolve/main/sd_xl_base_1.0.safetensors";
    expect(needsWith({ [name]: { directory: "checkpoints", url: hf } })).toEqual({ files: [name], download: true });
    expect(needsWith({ [name]: { directory: "checkpoints", url: "https://civitai.com/api/download/models/1" } })).toEqual({ files: [name] });
    expect(needsWith({ [name]: { directory: "checkpoints", url: "http://huggingface.co/x.safetensors" } })).toEqual({ files: [name] });
    expect(needsWith({ [name]: { url: hf } })).toEqual({ files: [name] });
    expect(needsWith({ [name]: { directory: "checkpoints", url: "not an address" } })).toEqual({ files: [name] });
    // the pixel-art row's checkpoint has an address and its LoRA none: nothing to press for it
    const bare = listPresets(comfyLists(comfyInfo({ checkpoints: [], loras: [] }))).others;
    expect(bare.find((p) => p.id === "sdxl-lightning")?.needs?.download).toBe(true);
    expect(bare.find((p) => p.id === "sdxl-lightning-pixel")?.needs).toEqual({ files: ["sdxl_lightning_4step.safetensors", "RW_pixelart_XL_v1.safetensors"] });
  });

  it("run at the size the file was saved with, its memory estimated from the largest file it loads", () => {
    const { preset, size } = resolveChoice({ preset: "template:image_z_image_turbo", width: 1024, height: 1024 }, extra);
    // qwen_3_4b is the only one of its files the app knows the size of: 8.04 GB + 1.5 GiB
    expect(size).toEqual({ width: 1024, height: 1024, bytes: 8_044_982_048 + 1.5 * 1024 ** 3 });
    expect(preset.sources?.["ae.safetensors"]).toEqual({ directory: "vae", url: "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors" });
    expect(() => resolveChoice({ preset: "template:image_z_image_turbo", width: 512, height: 512 }, extra)).toThrow("does not run at 512 x 512");
    // a saved copy of the app's Klein graph: the largest of its three files, not their sum
    expect(workflowPreset({ id: "saved:klein", name: "klein", group: "Your workflows", graph: PRESETS[0]!.workflow }).sizes).toEqual([{ width: 1024, height: 1024, bytes: 8_044_982_048 + 1.5 * 1024 ** 3 }]);
  });

  it("a job fills in the template's own prompt box and names its files as ComfyUI lists them", () => {
    const preset = resolveChoice({ preset: "template:image_sdxl_simple", width: 1024, height: 1024 }, extra).preset;
    const graph = jobGraph(preset, comfyInfo({ checkpoints: ["xl/sd_xl_base_1.0.safetensors"] }), { prompt: "a fox", seed: 5, width: 1024, height: 1024 });
    expect(graph["10"]!.inputs["text"]).toBe("a fox");
    expect(graph["15"]!.inputs["ckpt_name"]).toBe("xl/sd_xl_base_1.0.safetensors");
  });
});
