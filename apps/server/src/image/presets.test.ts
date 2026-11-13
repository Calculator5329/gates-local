// The app's setups judged against ComfyUI's lists: ready, needing files, or refused with the reason.
import { describe, expect, it } from "vitest";
import { APP_FILES, comfyInfo, KLEIN_COMPACT_FILES, KLEIN_FILES, MOSS_FILES, SDXL_FILES, ZIMAGE_FILES, type FakeFiles } from "../../test/comfy/info.ts";
import { readFileSync } from "node:fs";
import { imageFitVerdict } from "@gates-local/contracts";
import { cardBytes, comfyLists, defaultChoice, jobGraph, listPresets, presetFiles, PRESETS, resolveChoice, RETIRED, tiersFor, workflowPreset, type Preset } from "./presets.ts";
import { keepWorkflow } from "./sources.ts";
import { cellsFor, STYLE_CELLS } from "./styles.ts";
import files from "./setups/files.json" with { type: "json" };

const GIB = 1024 ** 3;
const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);
const template = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../test/comfy/templates/${name}.json`, import.meta.url), "utf8"));
const GENERAL_IDS = ["flux2-klein-4b", "flux2-klein-4b-compact", "z-image-int8", "moss-image"];
// The style bench's winners on a 16 GB card (or one whose size is not known), in the styles' order
const KLEIN_CELLS = ["general--r2-2a-klein-compact8", "characters--klein-official4", "pixel-art--r2-1a-klein-compact8"];
const MOSS_CELLS = ["portraits--moss-official25", "sprites--r2-1a-moss-official25", "backgrounds--r2-1b-moss-official25", "icons--r2-2a-moss-official25", "text-logos--moss-official25", "painterly--r2-2a-moss-official25"];
const CELLS = ["general--r2-2a-klein-compact8", "portraits--moss-official25", "characters--klein-official4", "pixel-art--r2-1a-klein-compact8", ...MOSS_CELLS.slice(1)];
const without = (list: readonly string[], ...gone: string[]) => list.filter((id) => !gone.includes(id));
const lists = (...f: FakeFiles[]) => comfyLists(comfyInfo(...f));
/** Each tier's setup at this many GiB of room ("Tier: id"). */
const tiersAt = (gib: number | undefined) => tiersFor(gib === undefined ? undefined : gib * GIB).map((t) => `${t.tier}: ${t.preset}`);

describe("listPresets", () => {
  it("lists a setup whose files ComfyUI does not name as needing them, by the names its workflow gives", () => {
    const { ready, others } = listPresets(lists(KLEIN_FILES));
    // Klein with the full encoder: the plain setup and the Characters cell; every other cell needs the FP4 encoder or MOSS
    expect(ids(ready)).toEqual(["flux2-klein-4b", "characters--klein-official4"]);
    expect(ids(others)).toEqual(["flux2-klein-4b-compact", "z-image-int8", "moss-image", ...without(CELLS, "characters--klein-official4")]);
    // the sizes are the app's own record of each file (setups/files.json)
    expect(others[0]).toMatchObject({ needs: { files: ["qwen_3_4b_fp4_flux2.safetensors"], bytes: 3_848_213_998, download: true } });
    expect(others[2]).toMatchObject({ needs: { files: ["moss_image_sft_int8_convrot.safetensors", "qwen3.5_9b_w4a8_gptq.safetensors"], bytes: 5_413_698_958 + 7_343_591_088, download: true } });
  });

  it("refuses a setup whose node class this ComfyUI does not list, and says which", () => {
    const info = comfyInfo(...APP_FILES);
    delete info["Flux2Scheduler"];
    const { ready, others } = listPresets(comfyLists(info));
    expect(ids(ready)).toEqual(["z-image-int8", "moss-image", ...MOSS_CELLS]);
    expect(ids(others)).toEqual(["flux2-klein-4b", "flux2-klein-4b-compact", ...KLEIN_CELLS]);
    expect(others[0]).toMatchObject({ id: "flux2-klein-4b", why: "Needs a node this ComfyUI does not have: Flux2Scheduler (a custom node, or one from a newer ComfyUI)." });
  });

  it("a kept list from before node classes were kept judges files only", () => {
    const { files: listed } = lists(...APP_FILES);
    expect(ids(listPresets({ files: listed }).ready)).toEqual([...GENERAL_IDS, ...CELLS]);
  });

  it("lists the style cells of the card's level only: one per style, the CPU's on the CPU, none on a GPU under 4 GiB", () => {
    const all = lists(...APP_FILES);
    const cells = (room: number) => ids(listPresets(all, [], room).ready).slice(GENERAL_IDS.length);
    expect(cells(16 * GIB)).toEqual(CELLS);
    expect(cells(24 * GIB), "a card bigger than any level runs the top one").toEqual(CELLS);
    expect(cells(8 * GIB)).toEqual(ids(cellsFor("8")));
    expect(cells(8 * GIB).map((id) => id.split("--")[0])).toEqual(CELLS.map((id) => id.split("--")[0]));
    expect(cells(0)).toEqual(ids(cellsFor("cpu")));
    expect(cells(0).every((id) => id.includes("--cpu-"))).toBe(true);
    expect(cells(3 * GIB)).toEqual([]);
  });

  it("with the setup's one download (compact Klein), every style has a ready cell at every level; MOSS and the full encoder are offered", () => {
    const compact = lists(KLEIN_COMPACT_FILES);
    for (const gib of [16, 12, 8, 6, 4]) {
      const { ready, others } = listPresets(compact, [], gib * GIB);
      const cells = ready.filter((p) => p.id.includes("--"));
      expect(cells.map((c) => c.id.split("--")[0]), `${gib} GiB`).toEqual(CELLS.map((id) => id.split("--")[0]));
      expect(cells.every((c) => c.id.includes("klein-compact")), `${gib} GiB`).toBe(true);
      // the level's own winner, where it is not Klein compact, is the second download
      for (const won of cellsFor(String(gib) as "16").filter((c) => !c.id.includes("klein-compact"))) {
        expect(others.find((p) => p.id === won.id)?.needs, `${gib} GiB ${won.id}`).toMatchObject({ download: true });
      }
    }
  });

  it("under 32 GB of system memory no MOSS cell is a style's row: the style's compact Klein is, and MOSS stays listed without a style", () => {
    const all = lists(...APP_FILES);
    // the rows the picker can take as a style's default: every listed row that names a style
    const styled = (gib: number, ram?: number) => { const { ready, others } = listPresets(all, [], gib * GIB, ram); return ids([...ready, ...others].filter((p) => p.style !== undefined)); };
    expect(styled(16), "memory not known").toEqual(CELLS);
    expect(styled(16, 31.25 * GIB), "a 32 GB computer reports a little under 32 GiB").toEqual(CELLS);
    for (const gib of [16, 12, 6, 4]) {
      const short = listPresets(all, [], gib * GIB, 16 * GIB);
      const rows = ids([...short.ready, ...short.others].filter((p) => p.style !== undefined));
      expect(rows.filter((id) => id.includes("moss")), `${gib} GiB`).toEqual([]);
      expect(rows.map((id) => id.split("--")[0]), `${gib} GiB: one row per style still`).toEqual(CELLS.map((id) => id.split("--")[0]));
      for (const cell of cellsFor(String(gib) as "16").filter((c) => c.family === "moss")) {
        expect(short.ready.find((p) => p.id === cell.id), `${gib} GiB ${cell.id} stays under Other models`).toBeDefined();
        expect(short.ready.find((p) => p.id === cell.id)?.style, `${gib} GiB ${cell.id}`).toBeUndefined();
      }
    }
  });

  it("every file the app's own setups load has a pinned size, sha256 and download address", () => {
    const bare = listPresets(lists()).others;
    for (const id of [...GENERAL_IDS, ...CELLS]) expect(bare.find((p) => p.id === id)?.needs).toMatchObject({ download: true, bytes: expect.any(Number) });
    for (const name of new Set([...PRESETS, ...STYLE_CELLS, ...RETIRED].flatMap(presetFiles))) expect((files as Record<string, unknown>)[name]).toMatchObject({ bytes: expect.any(Number), sha256: expect.stringMatching(/^[0-9a-f]{64}$/), url: expect.stringMatching(/^https:\/\/huggingface\.co\/.+\/resolve\/[0-9a-f]{40}\//) });
  });
});

describe("jobGraph", () => {
  const zImage = resolveChoice({ preset: "z-image-int8", width: 1024, height: 1024 }).preset;
  const moss = resolveChoice({ preset: "moss-image", width: 1024, height: 1024 }).preset;

  it("names each file as ComfyUI lists it, subfolder included", () => {
    const graph = jobGraph(zImage, comfyInfo({ ...ZIMAGE_FILES, diffusion_models: ["z/z_image_turbo_int8_convrot.safetensors"] }), { prompt: "a", seed: 1, width: 1024, height: 768 });
    expect(graph["57:28"]!.inputs["unet_name"]).toBe("z/z_image_turbo_int8_convrot.safetensors");
  });

  it("a file ComfyUI does not list fails in words that name it", () => {
    const info = comfyInfo({ ...MOSS_FILES, text_encoders: [] });
    expect(() => jobGraph(moss, info, { prompt: "a", seed: 1, width: 1024, height: 1024 })).toThrow(expect.objectContaining({ code: "image-model", file: "qwen3.5_9b_w4a8_gptq.safetensors" }));
  });

  it("the files a setup loads come from its workflow", () => {
    expect(presetFiles(moss)).toEqual(["moss_image_sft_int8_convrot.safetensors", "qwen3.5_9b_w4a8_gptq.safetensors", "flux2-vae.safetensors"]);
    expect(presetFiles(resolveChoice({ preset: "flux2-klein-4b-compact", width: 1024, height: 1024 }).preset)).toEqual(["flux-2-klein-4b-fp8.safetensors", "qwen_3_4b_fp4_flux2.safetensors", "flux2-vae.safetensors"]);
  });
});

// The owner's picks of 2026-11-13 on the GPU matrix of 2026-11-12: tiers by free GPU memory, no CPU default.
describe("the app's own setups, by GPU room", () => {
  const all = lists(...APP_FILES);

  it("SDXL Lightning, EpicRealism, the SDXL two-pass and SD 1.5 are in no setup", () => {
    expect(new Set(PRESETS.map((p) => p.family))).toEqual(new Set(["flux", "zimage", "moss"]));
    const loaded = PRESETS.flatMap(presetFiles).join(" ") + Object.keys(files).join(" ");
    expect(loaded).not.toMatch(/lightning|realism|sdxl|sd_xl|v1-5|sd15/i);
  });

  it("each needs the smallest cap the matrix ran it under: Klein 8 GiB (out of memory at 6), compact 4, Z-Image int8 6, MOSS 4", () => {
    const need = (id: string) => [...new Set(PRESETS.find((p) => p.id === id)!.sizes.map((s) => s.bytes / GIB))];
    expect(Object.fromEntries(PRESETS.map((p) => [p.id, need(p.id)]))).toEqual({
      "flux2-klein-4b": [8], "flux2-klein-4b-compact": [4], "z-image-int8": [6], "moss-image": [4],
    });
    // a style cell needs its model's: Klein with the full encoder 8, with the FP4 one 4, MOSS-Image 4
    for (const c of STYLE_CELLS) expect(c.sizes[0]!.bytes / GIB, c.id).toBe(presetFiles(c).includes("qwen_3_4b.safetensors") ? 8 : 4);
    expect(imageFitVerdict({ estimateBytes: 8 * GIB, freeBytes: 8 * GIB - 1, creditedBytes: 0 }).verdict).toBe("refuse");
  });

  it("tiers: Fast is Klein from 8 GiB and compact below; Balanced is Z-Image int8 from 6 and compact from 4; Best is MOSS from 4", () => {
    const top = ["Fast: flux2-klein-4b", "Balanced: z-image-int8", "Best: moss-image"];
    expect(tiersAt(16)).toEqual(top);
    expect(tiersAt(8)).toEqual(top);
    expect(tiersAt(undefined)).toEqual(top);
    expect(tiersAt(7.9)).toEqual(["Fast: flux2-klein-4b-compact", "Balanced: z-image-int8", "Best: moss-image"]);
    expect(tiersAt(6)).toEqual(["Fast: flux2-klein-4b-compact", "Balanced: z-image-int8", "Best: moss-image"]);
    expect(tiersAt(5.9)).toEqual(["Fast and balanced: flux2-klein-4b-compact", "Best: moss-image"]);
    expect(tiersAt(4)).toEqual(["Fast and balanced: flux2-klein-4b-compact", "Best: moss-image"]);
    expect(tiersAt(3.9)).toEqual([]);
    expect(tiersAt(0)).toEqual([]);
  });

  it("a card is its total memory to the nearest GB, as cards are sold: an 8 GB card that reports 8188 MiB gets the 8 GB tiers", () => {
    const MIB = 1024 ** 2;
    expect([16_303, 12_282, 8188, 6144, 4096, 3072].map((mib) => cardBytes(mib * MIB) / GIB)).toEqual([16, 12, 8, 6, 4, 3]);
    expect(tiersFor(cardBytes(8188 * MIB)).map((t) => t.preset)).toEqual(["flux2-klein-4b", "z-image-int8", "moss-image"]);
  });

  it("the default is the General style's cell for the card's level; without its files, Klein (compact below 8 GiB), then Z-Image int8, then MOSS-Image: the first that fits and is ready", () => {
    const at = (l: ReturnType<typeof lists> | undefined, gib?: number) => defaultChoice(l, [], gib === undefined ? undefined : gib * GIB)?.preset;
    expect(at(all)).toBe("general--r2-2a-klein-compact8");
    expect(at(all, 16)).toBe("general--r2-2a-klein-compact8");
    expect(at(all, 12)).toBe("general--r2-2a-klein-compact8");
    expect(at(all, 8)).toBe("general--fit-8b-klein-compact8");
    expect(at(all, 7), "a 7 GiB card runs the 6 GB level").toBe("general--fit-8b-klein-compact8");
    expect(at(all, 4)).toBe("general--fit-4a-klein-compact8");
    expect(at(lists(KLEIN_COMPACT_FILES), 4)).toBe("general--fit-4a-klein-compact8");
    // the General cells need the FP4 encoder: with only the full one, Klein stands in
    expect(at(lists(KLEIN_FILES), 16)).toBe("flux2-klein-4b");
    expect(at(lists(ZIMAGE_FILES, MOSS_FILES), 7)).toBe("z-image-int8");
    expect(at(lists(ZIMAGE_FILES, MOSS_FILES), 5)).toBe("moss-image");
    expect(at(lists(MOSS_FILES), 16)).toBe("moss-image");
    // none ready: the General cell, so the send names its missing files and the picker offers them
    expect(at(lists(), 16)).toBe("general--r2-2a-klein-compact8");
    expect(at(lists(), 5)).toBe("general--fit-4a-klein-compact8");
    expect(at(undefined, 5)).toBe("general--fit-4a-klein-compact8");
    expect(defaultChoice(all)).toEqual({ preset: "general--r2-2a-klein-compact8", width: 896, height: 896 });
    // under 32 GB of system memory MOSS-Image is never the default: the General cell stands, so the send names its files
    expect(defaultChoice(lists(MOSS_FILES), [], 16 * GIB, 16 * GIB)?.preset).toBe("general--r2-2a-klein-compact8");
    expect(defaultChoice(lists(ZIMAGE_FILES, MOSS_FILES), [], 5 * GIB, 16 * GIB)?.preset).toBe("general--fit-4a-klein-compact8");
    expect(defaultChoice(lists(MOSS_FILES), [], 16 * GIB, 31.25 * GIB)?.preset).toBe("moss-image");
  });

  it("no default on a GPU under 4 GiB; on the CPU the General style's CPU cell, and no GPU setup stands in for it", () => {
    expect(defaultChoice(all, [], 4 * GIB - 1)).toBeUndefined();
    expect(defaultChoice(all, [], 0)).toEqual({ preset: "general--cpu-klein-fp4-768-2", width: 768, height: 768 });
    expect(defaultChoice(undefined, [], 0)).toMatchObject({ preset: "general--cpu-klein-fp4-768-2" });
    expect(defaultChoice(lists(KLEIN_FILES, ZIMAGE_FILES), [], 0)).toMatchObject({ preset: "general--cpu-klein-fp4-768-2" });
    expect(defaultChoice(all, [], 4 * GIB)).toMatchObject({ preset: "general--fit-4a-klein-compact8" });
  });

  it("a template or a person's own setup is never the default, even when it is the only one ready", () => {
    const zbf16 = { diffusion_models: ["z_image_turbo_bf16.safetensors"], text_encoders: ["qwen_3_4b.safetensors"], vae: ["ae.safetensors"] };
    const zinfo = comfyInfo(zbf16, { checkpoints: ["sd_xl_base_1.0.safetensors"] });
    const zimage = workflowPreset(keepWorkflow("template:image_z_image_turbo", "Z-Image Turbo", "ComfyUI templates", template("image_z_image_turbo"), zinfo));
    const sdxl = workflowPreset(keepWorkflow("template:image_sdxl_simple", "SDXL", "ComfyUI templates", template("image_sdxl_simple"), zinfo));
    expect(ids(listPresets(comfyLists(zinfo), [zimage, sdxl]).ready)).toEqual(["template:image_z_image_turbo", "template:image_sdxl_simple"]);
    expect(defaultChoice(comfyLists(zinfo), [zimage, sdxl])).toMatchObject({ preset: "general--r2-2a-klein-compact8" });
  });
});

describe("themes", () => {
  const info = comfyInfo(KLEIN_FILES);
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

  it("the composer's short names start with letters no other setup of the app's uses", () => {
    const firsts = PRESETS.map((p) => p.short[0]!.toLowerCase());
    expect(new Set(firsts).size).toBe(firsts.length);
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
    const own = [...PRESETS, ...cellsFor("16")];
    expect(ids(ready)).toEqual([]);
    expect(ids(others.slice(0, own.length))).toEqual(ids(own));
    expect(others.slice(own.length)).toEqual([
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
  });

  it("run at the size the file was saved with, its memory estimated from the largest file it loads", () => {
    const { preset, size } = resolveChoice({ preset: "template:image_z_image_turbo", width: 1024, height: 1024 }, extra);
    // qwen_3_4b is the largest of its files the app knows the size of: 8.04 GB + 1.5 GiB
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
