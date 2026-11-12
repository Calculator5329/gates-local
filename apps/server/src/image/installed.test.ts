// The files already in ComfyUI's folders become setups, placed by their safetensors headers. Every
// file here is a header written by the test (no weights): only what the header says is read.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comfyInfo, KLEIN_FILES, SDXL_FILES } from "../../test/comfy/info.ts";
import { familyOf, installedWorkflows, readHeader, readInstalled, readInstalledSetups, type Header } from "./installed.ts";
import { comfyLists, jobGraph, listPresets, resolveChoice, workflowPreset } from "./presets.ts";

/** A safetensors file's header and nothing after it: the 8-byte length, then the JSON. */
const safetensors = (tensors: Record<string, readonly number[]>, metadata: Record<string, string> = {}) => {
  const json = Buffer.from(JSON.stringify({ __metadata__: metadata, ...Object.fromEntries(Object.entries(tensors).map(([k, shape]) => [k, { dtype: "F16", shape, data_offsets: [0, 0] }])) }));
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(json.length));
  return Buffer.concat([length, json]);
};
const header = (shapes: Record<string, readonly number[]>, metadata: Record<string, string> = {}): Header => ({ shapes, metadata });
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
/** An SD or SDXL UNet's first layer, taking this many channels in (an inpainting one takes 9). */
const firstLayer = (channels: number) => ({ "model.diffusion_model.input_blocks.0.0.weight": [320, channels, 3, 3] });
/** A safetensors header whose JSON is exactly this many bytes long. */
const headerOfLength = (length: number) => {
  const json = Buffer.from(`{"__metadata__":{"a":"${"x".repeat(length - '{"__metadata__":{"a":""}}'.length)}"}}`);
  const head = Buffer.alloc(8);
  head.writeBigUInt64LE(BigInt(json.length));
  return Buffer.concat([head, json]);
};

// Shapes as FLUX.2 Klein 4B's own file has them: 5 double and 20 single blocks 3072 wide, a text input 7680 wide.
const fluxBlocks = (double: number, single: number, prefix = "") => Object.fromEntries([
  ...range(double).map((i) => [`${prefix}double_blocks.${i}.img_attn.qkv.weight`, [9216, 3072]]),
  ...range(single).map((i) => [`${prefix}single_blocks.${i}.linear1.weight`, [27648, 3072]]),
]);
const KLEIN = { ...fluxBlocks(5, 20), "txt_in.weight": [3072, 7680], "img_in.weight": [3072, 128] };
const kleinLora = Object.fromEntries(Object.entries(fluxBlocks(5, 20, "diffusion_model.")).map(([k]) => [k.replace(".weight", ".lora_A.weight"), [16, 3072]]));
const SDXL = { "conditioner.embedders.0.transformer.text_model.final_layer_norm.weight": [768], "conditioner.embedders.1.model.ln_final.weight": [1280] };
const SDXL_LORA = { "lora_te1_text_model_encoder_layers_0_mlp_fc1.lora_down.weight": [16, 768], "lora_te2_text_model_encoder_layers_0_mlp_fc1.lora_down.weight": [16, 1280] };
/** What ComfyUI lists: the files the test writes, one named outside the folder, one missing, and two through links to elsewhere. */
const lists = () => comfyLists(comfyInfo({
  checkpoints: ["xl/juggernaut.safetensors", "dreamshaper_lightning.safetensors", "inpaint.safetensors", "../outside.safetensors", "missing.safetensors", "linked.safetensors", "pipe.safetensors", "sd_inpaint.safetensors", "shelf/base.safetensors"],
  loras: ["ink.safetensors", "klein-pixel.safetensors", "old15.safetensors", "zi.safetensors"],
}));
const SD15_LORA = { "lora_te_text_model_encoder_layers_0_mlp_fc1.lora_down.weight": [16, 768], "lora_unet_down_blocks_0_attentions_0_proj_in.lora_down.weight": [16, 320] };

describe("familyOf", () => {
  it("reads the family the metadata names first", () => {
    expect(familyOf(header({}, { "modelspec.architecture": "stable-diffusion-xl-v1-base/lora" }), "loras")).toBe("sdxl");
    expect(familyOf(header(SDXL_LORA, { ss_base_model_version: "sd_v1" }), "loras")).toBe("sd15");
    expect(familyOf(header(KLEIN, { "modelspec.architecture": "Flux.1-dev" }), "checkpoints")).toBe("flux1");
  });

  it("else the tensor names: SDXL has a second text encoder, SD 1.5 one", () => {
    expect(familyOf(header(SDXL), "checkpoints")).toBe("sdxl");
    expect(familyOf(header(SDXL_LORA), "loras")).toBe("sdxl");
    expect(familyOf(header(SD15_LORA), "loras")).toBe("sd15");
    expect(familyOf(header({ "cond_stage_model.transformer.text_model.final_layer_norm.weight": [768] }), "checkpoints")).toBe("sd15");
  });

  it("Klein 4B by its shapes: blocks 3072 wide, no more than 5 double and 20 single", () => {
    expect(familyOf(header(KLEIN), "checkpoints")).toBe("flux2-klein-4b");
    expect(familyOf(header(kleinLora), "loras")).toBe("flux2-klein-4b");
    expect(familyOf(header({ ...fluxBlocks(19, 38), "txt_in.weight": [3072, 4096], "img_in.weight": [3072, 64] }), "checkpoints")).toBe("flux1");
    expect(familyOf(header(fluxBlocks(19, 38, "diffusion_model.")), "loras")).toBe("flux1");
    // a wider model with few blocks is not Klein 4B
    expect(familyOf(header({ "double_blocks.0.img_attn.qkv.weight": [12288, 4096] }), "loras")).toBeUndefined();
  });

  it("leaves out inpainting and audio models, and files it cannot place", () => {
    expect(familyOf(header({ ...KLEIN, "img_in.weight": [3072, 384] }), "checkpoints")).toBeUndefined();
    expect(familyOf(header(SDXL, { "modelspec.architecture": "stable-diffusion-xl-v1-inpainting" }), "checkpoints")).toBeUndefined();
    expect(familyOf(header({ "conditioner.conditioners.seconds_start.embedder.weight": [768] }), "checkpoints")).toBeUndefined();
    expect(familyOf(header({ "model.layers.0.weight": [10] }), "checkpoints")).toBeUndefined();
  });

  it("leaves out an SD or SDXL inpainting checkpoint by its first layer: 9 channels in, not 4", () => {
    expect(familyOf(header({ ...SDXL, ...firstLayer(9) }), "checkpoints")).toBeUndefined();
    expect(familyOf(header({ "cond_stage_model.transformer.text_model.final_layer_norm.weight": [768], ...firstLayer(9) }), "checkpoints")).toBeUndefined();
    expect(familyOf(header({ ...SDXL, ...firstLayer(4) }), "checkpoints")).toBe("sdxl");
  });
});

describe("the files in ComfyUI's folders", () => {
  let root: string;
  const folders = () => ({ checkpoints: [path.join(root, "checkpoints")], loras: [path.join(root, "loras")] });
  const files: Record<string, Buffer> = {
    "checkpoints/xl/juggernaut.safetensors": safetensors(SDXL),
    "checkpoints/dreamshaper_lightning.safetensors": safetensors(SDXL, { "modelspec.title": "DreamShaper XL Lightning" }),
    "checkpoints/sdxl_lightning_4step.safetensors": safetensors(SDXL),
    "checkpoints/inpaint.safetensors": safetensors(SDXL, { "modelspec.architecture": "stable-diffusion-xl-v1-inpainting" }),
    "loras/ink.safetensors": safetensors(SDXL_LORA),
    "loras/RW_pixelart_XL_v1.safetensors": safetensors(SDXL_LORA),
    "loras/klein-pixel.safetensors": safetensors(kleinLora),
    "loras/old15.safetensors": safetensors(SD15_LORA),
    "loras/zi.safetensors": safetensors({}, { "modelspec.architecture": "z-image-turbo/lora" }),
    "outside.safetensors": safetensors(SDXL),
    "store/base.safetensors": safetensors(SDXL),
  };

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "gates-installed-"));
    for (const [name, bytes] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), bytes);
    }
    await writeFile(path.join(root, "checkpoints/huge.safetensors"), Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]));
    // linked from elsewhere, as people keep models on another disk: a file, and a folder; ComfyUI lists and runs both
    await symlink(path.join(root, "outside.safetensors"), path.join(root, "checkpoints/linked.safetensors"));
    await symlink(path.join(root, "store"), path.join(root, "checkpoints/shelf"));
    // listed by ComfyUI but not read: a pipe (reading it would wait for ever), an inpainting checkpoint
    execFileSync("mkfifo", [path.join(root, "checkpoints/pipe.safetensors")]);
    await writeFile(path.join(root, "checkpoints/sd_inpaint.safetensors"), safetensors({ ...SDXL, "model.diffusion_model.input_blocks.0.0.weight": [320, 9, 3, 3] }));
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it("a header reads as its metadata and shapes; a file that is not one reads as nothing", async () => {
    expect(await readHeader(path.join(root, "loras/zi.safetensors"))).toEqual({ metadata: { "modelspec.architecture": "z-image-turbo/lora" }, shapes: {} });
    expect(await readHeader(path.join(root, "checkpoints/huge.safetensors"))).toBeUndefined();
  });

  it("a header up to 8 MiB is read; one longer is not", async () => {
    const at = path.join(root, "at-cap.safetensors"), over = path.join(root, "over-cap.safetensors");
    await writeFile(at, headerOfLength(8 * 1024 * 1024));
    await writeFile(over, headerOfLength(8 * 1024 * 1024 + 1));
    expect((await readHeader(at))?.metadata["a"]).toHaveLength(8 * 1024 * 1024 - 25);
    expect(await readHeader(over)).toBeUndefined();
  });

  it("are read only inside the folders ComfyUI names, links out of them included, and only those it can place", async () => {
    const read = await readInstalled(folders(), lists().files);
    expect(read.map((f) => `${f.kind}/${f.name}`)).toEqual([
      "checkpoints/xl/juggernaut.safetensors", "checkpoints/dreamshaper_lightning.safetensors", "checkpoints/linked.safetensors", "checkpoints/shelf/base.safetensors",
      "loras/ink.safetensors", "loras/klein-pixel.safetensors", "loras/old15.safetensors", "loras/zi.safetensors",
    ]);
    expect(read[0]).toEqual({ kind: "checkpoints", name: "xl/juggernaut.safetensors", bytes: files["checkpoints/xl/juggernaut.safetensors"]!.length, family: "sdxl" });
    expect(read[1]).toMatchObject({ fewStep: true });
  });

  it("become setups in Your models: ready, needing the base's files, or refused with the reason", async () => {
    const extra = installedWorkflows(await readInstalled(folders(), lists().files)).map(workflowPreset);
    const { ready, others } = listPresets(lists(), extra);
    expect(ready.filter((p) => p.group === "Your models").map((p) => p.name)).toEqual(["juggernaut", "dreamshaper_lightning", "linked", "base"]);
    expect(others.filter((p) => p.group === "Your models")).toEqual([
      // a style on the app's SDXL Lightning setup, whose checkpoint is not installed: 6.94 GB
      expect.objectContaining({ id: "file:loras/ink.safetensors", name: "ink style", family: "sdxl", needs: { files: ["sdxl_lightning_4step.safetensors"], bytes: 6_938_040_682, download: true } }),
      // a style on Klein 4B, none of whose three files is installed: 4.07 + 8.04 + 0.34 GB
      expect.objectContaining({ id: "file:loras/klein-pixel.safetensors", family: "flux", needs: { files: ["flux-2-klein-4b-fp8.safetensors", "qwen_3_4b.safetensors", "flux2-vae.safetensors"], bytes: 12_451_817_860, download: true } }),
      expect.objectContaining({ id: "file:loras/old15.safetensors", why: "A Stable Diffusion 1.5 LoRA; it needs a Stable Diffusion 1.5 model, and none is installed." }),
      expect.objectContaining({ id: "file:loras/zi.safetensors", why: "A Z-Image Turbo LoRA; it needs a Z-Image Turbo model, and Image mode has no Z-Image Turbo setup." }),
    ]);
  });

  it("a checkpoint runs at its family's plain settings, unless it says it is a few-step model", async () => {
    const extra = installedWorkflows(await readInstalled(folders(), lists().files)).map(workflowPreset);
    const run = (id: string) => jobGraph(resolveChoice({ preset: id, width: 1024, height: 1024 }, extra).preset, comfyInfo({ checkpoints: ["xl/juggernaut.safetensors", "dreamshaper_lightning.safetensors"] }), { prompt: "a fox", seed: 1, width: 1024, height: 1024 });
    expect(run("file:checkpoints/xl/juggernaut.safetensors")["6"]!.inputs).toMatchObject({ steps: 28, cfg: 5, sampler_name: "dpmpp_2m", scheduler: "karras" });
    expect(run("file:checkpoints/dreamshaper_lightning.safetensors")["6"]!.inputs).toMatchObject({ steps: 4, cfg: 1, sampler_name: "euler", scheduler: "sgm_uniform" });
  });

  it("the app's SDXL Lightning setup runs its own 4 steps at cfg 1, euler on sgm_uniform", () => {
    const preset = resolveChoice({ preset: "sdxl-lightning", width: 768, height: 512 }, []).preset;
    const graph = jobGraph(preset, comfyInfo(SDXL_FILES), { prompt: "a fox", seed: 1, width: 768, height: 512 });
    const sampler = Object.values(graph).find((n) => n.class_type === "KSampler");
    expect(sampler?.inputs).toMatchObject({ steps: 4, cfg: 1, sampler_name: "euler", scheduler: "sgm_uniform", seed: 1 });
  });

  it("a LoRA is loaded at 0.8 on its base: model and text encoder on SDXL, model only on Klein", async () => {
    const extra = installedWorkflows(await readInstalled(folders(), lists().files)).map(workflowPreset);
    const info = comfyInfo(SDXL_FILES, KLEIN_FILES, { loras: ["ink.safetensors", "styles/klein-pixel.safetensors"] });
    const job = (id: string, width: number, height: number) => jobGraph(resolveChoice({ preset: id, width, height }, extra).preset, info, { prompt: "a fox", seed: 1, width, height });
    const ink = job("file:loras/ink.safetensors", 768, 512);
    expect(ink["2"]).toEqual({ class_type: "LoraLoader", inputs: { lora_name: "ink.safetensors", strength_model: 0.8, strength_clip: 0.8, model: ["1", 0], clip: ["1", 1] } });
    expect([ink["6"]!.inputs["model"], ink["3"]!.inputs["clip"]]).toEqual([["2", 0], ["2", 1]]);
    const pixel = job("file:loras/klein-pixel.safetensors", 1024, 1024);
    expect(pixel["14"]).toEqual({ class_type: "LoraLoaderModelOnly", inputs: { lora_name: "styles/klein-pixel.safetensors", strength_model: 0.8, model: ["1", 0] } });
    expect(pixel["6"]!.inputs["model"]).toEqual(["14", 0]);
  });

  it("files the app's own setups load are left out: they are those setups already", () => {
    const kept = installedWorkflows([
      { kind: "checkpoints", name: "sdxl/sdxl_lightning_4step.safetensors", bytes: 1, family: "sdxl", fewStep: true },
      { kind: "loras", name: "RW_pixelart_XL_v1.safetensors", bytes: 1, family: "sdxl" },
      { kind: "loras", name: "ink.safetensors", bytes: 1, family: "sdxl" },
    ]);
    expect(kept.map((w) => w.id)).toEqual(["file:loras/ink.safetensors"]);
  });

  it("an SD 1.5 LoRA runs on the installed SD 1.5 checkpoint, at 512 x 512", () => {
    const [style] = installedWorkflows([
      { kind: "checkpoints", name: "v15.safetensors", bytes: 2_000_000_000, family: "sd15" },
      { kind: "loras", name: "old15.safetensors", bytes: 1000, family: "sd15" },
    ]).slice(1).map(workflowPreset);
    expect(style).toMatchObject({ family: "sd15", sizes: [{ width: 512, height: 512 }] });
    const graph = jobGraph(style!, comfyInfo({ checkpoints: ["v15.safetensors"], loras: ["old15.safetensors"] }), { prompt: "a", seed: 1, width: 512, height: 512 });
    expect([graph["1"]!.inputs["ckpt_name"], graph["2"]!.inputs["lora_name"], graph["6"]!.inputs["cfg"]]).toEqual(["v15.safetensors", "old15.safetensors", 7]);
  });

  it("only for a ComfyUI on this machine", async () => {
    const asked: string[] = [];
    const get = async (route: string) => { asked.push(route); return folders(); };
    expect(await readInstalledSetups(get, "http://192.0.2.10:8188", lists().files)).toBeUndefined();
    expect(asked).toEqual([]);
    expect((await readInstalledSetups(get, "http://127.0.0.1:9", lists().files))?.map((w) => w.id)).toContain("file:checkpoints/xl/juggernaut.safetensors");
    expect(await readInstalledSetups(async () => { throw new Error("404"); }, "http://localhost:9", lists().files)).toBeUndefined();
  });
});
