// The app's setups judged against ComfyUI's lists: ready, needing files, or refused with the reason.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APP_FILES, comfyInfo, KLEIN_COMPACT_FILES, KLEIN_FILES, MOSS_FILES, SDXL_FILES, ZIMAGE_FILES, type FakeFiles } from "../../test/comfy/info.ts";
import { readFileSync } from "node:fs";
import { imageFitVerdict, type GpuStatus, type ImageChoice, type ImageEvent } from "@gates-local/contracts";
import { cardBytes, comfyLists, DEFAULT_CHOICE, DEFAULT_ORDER, defaultChoice, imageOffLine, imageToolChoice, isDefaultChoice, jobGraph, listPresets, presetFiles, PRESETS, resolveChoice, RETIRED, tiersFor, workflowPreset, type Preset } from "./presets.ts";
import { createGpuLease } from "../gpu/lease.ts";
import { openThreadStore, type ThreadStore } from "../threads/store.ts";
import { createImageModule } from "./module.ts";
import { keepWorkflow } from "./sources.ts";
import { cellsFor, STYLE_CELLS } from "./styles.ts";
import files from "./setups/files.json" with { type: "json" };

const GIB = 1024 ** 3;
const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);
const template = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../test/comfy/templates/${name}.json`, import.meta.url), "utf8"));
// Klein is one row: the full setup on a card of 8 GB or more, or one whose size is not known
const GENERAL_IDS = ["flux2-klein-4b", "z-image-int8", "moss-image"];
const APP_ROWS = PRESETS.filter((p) => p.id !== "flux2-klein-4b-compact");
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
    expect(ids(others)).toEqual(["z-image-int8", "moss-image", ...without(CELLS, "characters--klein-official4")]);
    // the sizes are the app's own record of each file (setups/files.json)
    expect(others.find((p) => p.id === "general--r2-2a-klein-compact8")).toMatchObject({ needs: { files: ["qwen_3_4b_fp4_flux2.safetensors"], bytes: 3_848_213_998, download: true } });
    expect(others[1]).toMatchObject({ needs: { files: ["moss_image_sft_int8_convrot.safetensors", "qwen3.5_9b_w4a8_gptq.safetensors"], bytes: 5_413_698_958 + 7_343_591_088, download: true } });
  });

  it("refuses a setup whose node class this ComfyUI does not list, and says which", () => {
    const info = comfyInfo(...APP_FILES);
    delete info["Flux2Scheduler"];
    const { ready, others } = listPresets(comfyLists(info));
    expect(ids(ready)).toEqual(["z-image-int8", "moss-image", ...MOSS_CELLS]);
    expect(ids(others)).toEqual(["flux2-klein-4b", ...KLEIN_CELLS]);
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
    // Klein's one row with both setups on disk: the full one where it fits the card, the compact one below
    const klein = (gib: number) => ids(listPresets(all, [], gib * GIB).ready).filter((id) => id.startsWith("flux2-klein-4b"));
    expect(klein(16)).toEqual(["flux2-klein-4b"]);
    expect(klein(8)).toEqual(["flux2-klein-4b"]);
    expect(klein(6)).toEqual(["flux2-klein-4b-compact"]);
    // on the CPU there is no card to judge by: the Klein that runs is the row
    const fullOnly = lists(KLEIN_FILES);
    expect(ids(listPresets(fullOnly, [], 0).ready).filter((id) => id.startsWith("flux2-klein-4b"))).toEqual(["flux2-klein-4b"]);
    expect(ids(listPresets(fullOnly, [], 6 * GIB).ready).filter((id) => id.startsWith("flux2-klein-4b"))).toEqual([]);
  });

  it("with the setup's one download (compact Klein), every style has a ready cell at every level; MOSS and the full encoder are offered", () => {
    const compact = lists(KLEIN_COMPACT_FILES);
    for (const gib of [16, 12, 8, 6, 4]) {
      const { ready, others } = listPresets(compact, [], gib * GIB);
      const cells = ready.filter((p) => p.id.includes("--"));
      expect(cells.map((c) => c.id.split("--")[0]), `${gib} GiB`).toEqual(CELLS.map((id) => id.split("--")[0]));
      // Klein is one row, the setup on disk: the full one would be a download, and the compact one fits every card
      expect([...ready, ...others].filter((p) => p.id.startsWith("flux2-klein-4b")).map((p) => p.id), `${gib} GiB`).toEqual(["flux2-klein-4b-compact"]);
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

  it("a sprite is asked for on a flat magenta field and saved as drawn, with no cut-out step", () => {
    const sprite = jobGraph(resolveChoice({ preset: "flux2-klein-4b-sprites", width: 768, height: 768 }).preset, info, values);
    const pixel = jobGraph(resolveChoice({ preset: "flux2-klein-4b-pixel", width: 768, height: 768 }).preset, info, values);
    expect(sprite["4"]!.inputs["text"]).toContain("isolated on a uniform solid pure magenta background (#FF00FF), no magenta on the subject");
    const classes = (graph: typeof sprite) => Object.values(graph).map((n) => n.class_type).toSorted();
    expect(classes(sprite)).toEqual(classes(pixel));
    expect(classes(sprite).filter((c) => /alpha|mask|background|rembg|composite/i.test(c))).toEqual([]);
    expect(sprite["13"]!.inputs["images"]).toEqual(["15", 0]);
  });

  it("the composer's short names start with letters no other setup of the app's uses", () => {
    const firsts = APP_ROWS.map((p) => p.short[0]!.toLowerCase());
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
    const own = [...APP_ROWS, ...cellsFor("16")];
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

describe("imageOffLine, the system prompt's line when the image tool is not offered", () => {
  it("in a turn with tools it is about images only and says the other tools still work", () => {
    const line = imageOffLine({ imageGen: true, imageTool: false }, true, true)!;
    expect(line).not.toMatch(/cannot make images in this chat/i);
    expect(line).toMatch(/^Making images is off in this chat; every other tool you have still works\./);
    expect(line).toContain('"Turn on Make images in Settings > Tools, or switch the message box to Image."');
  });

  it("in a turn without tools it names no tools", () => {
    const line = imageOffLine({ imageGen: false }, false, false)!;
    expect(line).toMatch(/^Making images is off in this chat\. /);
    expect(line).not.toMatch(/tool you have/);
  });

  it("is absent while the tool is offered", () => {
    expect(imageOffLine({ imageGen: true }, true, true)).toBeUndefined();
  });
});

describe("the picker's groups", () => {
  it("the app's own setups are grouped by theme: the model rows under General, each style's cell under that style's name", () => {
    const { ready } = listPresets(lists(...APP_FILES), [], 16 * GIB);
    expect(ready.map((p) => [p.id, p.group])).toEqual([
      ["flux2-klein-4b", "General"], ["z-image-int8", "General"], ["moss-image", "General"],
      ["general--r2-2a-klein-compact8", "General"], ["portraits--moss-official25", "Portraits and people"], ["characters--klein-official4", "Characters"],
      ["pixel-art--r2-1a-klein-compact8", "Pixel art"], ["sprites--r2-1a-moss-official25", "Game sprites"], ["backgrounds--r2-1b-moss-official25", "Backgrounds"],
      ["icons--r2-2a-moss-official25", "Icons"], ["text-logos--moss-official25", "Text and logos"], ["painterly--r2-2a-moss-official25", "Painterly and concept art"],
    ]);
  });
});

const sdxlGraph = (): Record<string, { class_type: string; inputs: Record<string, unknown> }> => JSON.parse(readFileSync(new URL("../../test/comfy/api/image_sdxl_simple.json", import.meta.url), "utf8"));
const broken = (change: (graph: ReturnType<typeof sdxlGraph>) => void) => { const graph = sdxlGraph(); change(graph); return graph; };
const named = (ckpt: string) => workflowPreset({ id: "saved:mine", name: "mine", group: "Your workflows", graph: broken((g) => { g["15"]!.inputs["ckpt_name"] = ckpt; }) }).family;

describe("a workflow Image mode cannot fill in", () => {
  it("is listed refused when it has no single prompt, size, seed or output, each with its own reason", () => {
    const graphs = {
      "no output": broken((g) => { delete g["7"]; }),
      "two prompts": broken((g) => {
        g["20"] = { class_type: "CLIPTextEncode", inputs: { text: "second", clip: ["15", 1] } };
        g["21"] = { class_type: "KSampler", inputs: { ...g["12"]!.inputs, positive: ["20", 0] } };
      }),
      "no size": broken((g) => { g["13"]!.class_type = "LatentUpscale"; }),
      "no seed": broken((g) => { delete g["12"]!.inputs["seed"]; }),
    };
    const extra = Object.entries(graphs).map(([name, graph]) => workflowPreset({ id: `saved:${name}`, name, group: "Your workflows", graph }));
    const { ready, others } = listPresets(comfyLists(comfyInfo(SDXL_FILES)), extra);
    expect(ready.filter((p) => p.id.startsWith("saved:"))).toEqual([]);
    expect(Object.fromEntries(others.filter((p) => p.id.startsWith("saved:")).map((p) => [p.name, p.why]))).toEqual({
      "no output": "It saves no picture: there is no Save Image or Preview Image node.",
      "two prompts": "It has 2 prompt boxes (nodes 10 and 20); Image mode fills in one.",
      "no size": "It has no empty latent node, so Image mode cannot set the picture's size.",
      "no seed": "It has no seed, so every picture would come out the same.",
    });
  });
});

const opened: Array<{ close(): Promise<void> }> = [];
const made: string[] = [];
afterEach(async () => {
  for (const one of opened.splice(0)) await one.close();
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const comfyWithZImage = async (input: string | URL | Request): Promise<Response> => {
  const route = new URL(String(input)).pathname;
  if (route === "/system_stats") return Response.json({ system: { comfyui_version: "fake" }, devices: [{ type: "cuda" }] });
  if (route === "/object_info") return Response.json(comfyInfo(ZIMAGE_FILES));
  return new Response("not found", { status: 404 });
};

async function pickerOver(folder: string, records?: false) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "gates-presets-left-"));
  made.push(dataDir);
  const module = createImageModule({
    dataDir, lease: createGpuLease(), store: { interruptImageJobs: () => [] } as unknown as ThreadStore, push: () => {}, log: () => {},
    settings: () => ({ imageGen: true, imageFolder: folder }),
    defaultUrl: "http://127.0.0.1:18999",
    localAddresses: () => ["127.0.0.1"], lookupHost: async () => ["127.0.0.1"],
    service: { inspect: async () => ({ present: false, active: false, activeState: "inactive", pid: 0 }), start: async () => {}, stop: async () => {} },
    fetch: comfyWithZImage,
    download: { freeBytes: async () => 10 ** 12, ...records === false ? { records } : {} },
  });
  opened.push(module);
  return module;
}

describe("what a setup has left to fetch", () => {
  it("is its bytes less the parts already in the download folder, and absent while a file's size is unknown", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "gates-presets-picked-"));
    made.push(folder);
    const vae = (files as Record<string, { url: string }>)["flux2-vae.safetensors"]!;
    const dir = path.join(folder, "vae", "gates-local");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "flux2-vae.safetensors.part"), Buffer.alloc(1000));
    await writeFile(path.join(dir, "flux2-vae.safetensors.part.json"), JSON.stringify({ url: vae.url, etag: "\"e\"", size: 336_211_292 }));
    const whole = 4_070_624_520 + 3_848_213_998 + 336_211_292;
    const row = async (records?: false) => (await (await pickerOver(folder, records)).presets()).others?.find((p) => p.id === "general--r2-2a-klein-compact8")?.needs;
    expect(await row()).toEqual({ files: ["flux-2-klein-4b-fp8.safetensors", "qwen_3_4b_fp4_flux2.safetensors", "flux2-vae.safetensors"], bytes: whole, download: true, leftBytes: whole - 1000 });
    const unknown = await row(false);
    expect(unknown).toMatchObject({ download: true });
    expect(unknown).not.toHaveProperty("leftBytes");
  });
});

const PNG = Buffer.from("iVBORw0KGgo=", "base64");
const nvidia = (bytes: number): GpuStatus => ({ vendor: "nvidia", totalBytes: bytes, freeBytes: bytes, occupants: [], systemMemoryAvailableBytes: 0, measuredAt: 0 });
const isRoute = (routes: Record<string, unknown>, route: string): boolean => Object.hasOwn(routes, route);

async function engineOver(start: { files?: readonly FakeFiles[]; routes?: Record<string, unknown>; choice?: ImageChoice; card?: number }) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "gates-presets-engine-"));
  made.push(dataDir);
  const store = openThreadStore(path.join(dataDir, "threads.sqlite"));
  const events: ImageEvent[] = [];
  const graphs: Record<string, { class_type: string; inputs: Record<string, unknown> }>[] = [];
  const routes = start.routes ?? {};
  const card = start.card;
  let served = start.files ?? [];
  let socket: EventTarget | undefined;
  const module = createImageModule({
    dataDir, lease: createGpuLease(), store, log: () => {},
    push: (channel, payload) => { if (channel === "image.event") events.push(payload as ImageEvent); },
    settings: () => ({ imageGen: true, ...start.choice === undefined ? {} : { imageChoice: start.choice } }),
    defaultUrl: "http://127.0.0.1:18999",
    localAddresses: () => ["127.0.0.1"], lookupHost: async () => ["127.0.0.1"],
    readGpu: async () => ({ freeBytes: 64 * GIB, holders: "" }),
    ...card === undefined ? {} : { gpuStatus: async () => nvidia(card) },
    socket: () => {
      socket = new EventTarget();
      Object.defineProperty(socket, "readyState", { value: 1 });
      Object.assign(socket, { close() {} });
      return socket as WebSocket;
    },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const route = `${url.pathname}${url.search}`;
      if (route === "/system_stats") return Response.json({ system: { comfyui_version: "fake" }, devices: [{ type: "cuda" }] });
      if (route === "/object_info") return Response.json(comfyInfo(...served));
      if (route === "/queue") return Response.json({ queue_running: [], queue_pending: [] });
      if (route === "/prompt") {
        graphs.push((JSON.parse(String(init?.body)) as { prompt: (typeof graphs)[number] }).prompt);
        queueMicrotask(() => socket?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "executing", data: { prompt_id: "p1", node: null } }) })));
        return Response.json({ prompt_id: "p1" });
      }
      if (route === "/history/p1") return Response.json({ p1: { outputs: { "13": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } } } });
      if (url.pathname === "/view") return new Response(PNG);
      return isRoute(routes, route) ? Response.json(routes[route]) : new Response("not found", { status: 404 });
    },
  });
  opened.push(module, { close: async () => store.close() });
  return { module, store, events, graphs, list: (next: readonly FakeFiles[]) => { served = next; } };
}

async function sdxlLoraFolder(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gates-presets-loras-"));
  made.push(root);
  const folder = path.join(root, "loras");
  await mkdir(folder);
  const json = Buffer.from(JSON.stringify({ "lora_te2_text_model_encoder_layers_0_mlp_fc1.lora_down.weight": { dtype: "F16", shape: [16, 1280], data_offsets: [0, 0] } }));
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(json.length));
  await writeFile(path.join(folder, "ink.safetensors"), Buffer.concat([length, json]));
  return folder;
}

describe("rules of the app's own setups", () => {
  it("a style cell's row names its model alone; a model's own row has no separate model name", () => {
    const { ready } = listPresets(lists(...APP_FILES), [], 16 * GIB);
    expect(ready.find((p) => p.id === "general--r2-2a-klein-compact8")).toMatchObject({ name: "FLUX.2 Klein 4B general", model: "FLUX.2 Klein 4B" });
    expect(ready.find((p) => p.id === "portraits--moss-official25")).toMatchObject({ name: "MOSS-Image portraits", model: "MOSS-Image" });
    for (const id of ["flux2-klein-4b", "z-image-int8", "moss-image"]) expect(ready.find((p) => p.id === id), id).not.toHaveProperty("model");
  });

  it("a setup offered at several sizes is a default at its first size", () => {
    for (const d of DEFAULT_ORDER) {
      const sizes = PRESETS.find((p) => p.id === d.preset)!.sizes;
      expect(sizes.length, d.preset).toBeGreaterThan(1);
      expect([d.width, d.height], d.preset).toEqual([sizes[0]!.width, sizes[0]!.height]);
    }
    expect(defaultChoice(lists(ZIMAGE_FILES), [], 7 * GIB)).toEqual({ preset: "z-image-int8", width: 1024, height: 1024 });
  });

  it("every size the app's own setups are offered at is at most 1024 x 1024 pixels, the wide ones too", () => {
    const all = [...PRESETS, ...STYLE_CELLS, ...RETIRED].flatMap((p) => p.sizes.map((s) => ({ id: p.id, ...s })));
    expect(all.some((s) => s.width > 1024)).toBe(true);
    for (const s of all) expect(s.width * s.height, `${s.id} ${s.width}x${s.height}`).toBeLessThanOrEqual(1024 * 1024);
  });

  it("compact Klein runs 12 steps on the FP4 text encoder", () => {
    const compact = PRESETS.find((p) => p.id === "flux2-klein-4b-compact")!;
    const graph = jobGraph(compact, comfyInfo(KLEIN_COMPACT_FILES), { prompt: "a fox", seed: 1, width: 1024, height: 1024 });
    const inputs = (cls: string) => Object.values(graph).filter((n) => n.class_type === cls).map((n) => n.inputs);
    expect(inputs("Flux2Scheduler")).toMatchObject([{ steps: 12 }]);
    expect(inputs("CLIPLoader")).toMatchObject([{ clip_name: "qwen_3_4b_fp4_flux2.safetensors" }]);
  });

  it("below 8 GiB, with the General cell refused, compact Klein is the default ahead of MOSS-Image", () => {
    const info = comfyInfo(KLEIN_COMPACT_FILES, MOSS_FILES);
    delete info["ConditioningZeroOut"];
    const listed = comfyLists(info);
    expect(listPresets(listed, [], 6 * GIB).others.find((p) => p.id === "general--fit-8b-klein-compact8")?.why).toMatch(/ConditioningZeroOut/);
    expect(defaultChoice(listed, [], 6 * GIB)).toEqual({ preset: "flux2-klein-4b-compact", width: 1024, height: 1024 });
    expect(defaultChoice(listed, [], 4 * GIB)).toEqual({ preset: "flux2-klein-4b-compact", width: 1024, height: 1024 });
  });

  it("a send of a default the composer may show counts as unset: any model of the default order, or the General cell of any card level", () => {
    expect(isDefaultChoice(undefined)).toBe(true);
    for (const d of DEFAULT_ORDER) expect(isDefaultChoice(d), d.preset).toBe(true);
    const general = STYLE_CELLS.filter((c) => c.style === "general");
    expect(general.length).toBeGreaterThan(1);
    for (const c of general) expect(isDefaultChoice({ preset: c.id, width: c.sizes[0]!.width, height: c.sizes[0]!.height }), c.id).toBe(true);
    expect(isDefaultChoice({ preset: "z-image-int8", width: 1024, height: 768 })).toBe(false);
    expect(isDefaultChoice({ preset: "pixel-art--r2-1a-klein-compact8", width: 640, height: 640 })).toBe(false);
  });

  it("a workflow refused as a job fails as an image-model error that names the setup and the reason", () => {
    const values = { prompt: "a fox", seed: 1, width: 1024, height: 1024 };
    const edit = workflowPreset({ id: "saved:edit", name: "edit", group: "Your workflows", why: "It starts from a picture (Load Image); Image mode makes pictures from words only." });
    expect(() => jobGraph(edit, comfyInfo(SDXL_FILES), values)).toThrow(expect.objectContaining({ code: "image-model", message: "edit: It starts from a picture (Load Image); Image mode makes pictures from words only." }));
    const info = comfyInfo(KLEIN_FILES);
    delete info["Flux2Scheduler"];
    expect(() => jobGraph(PRESETS[0]!, info, values)).toThrow(expect.objectContaining({ code: "image-model", message: "FLUX.2 Klein 4B: Needs a node this ComfyUI does not have: Flux2Scheduler (a custom node, or one from a newer ComfyUI)." }));
  });

  it("with nothing saved the image tool runs the default ComfyUI has every file for, judged at the top card level", () => {
    expect(imageToolChoice({ imageGen: true }, true)).toEqual(DEFAULT_CHOICE);
    expect(imageToolChoice({ imageGen: true }, true, lists(ZIMAGE_FILES))).toEqual({ preset: "z-image-int8", width: 1024, height: 1024 });
    expect(imageToolChoice({ imageGen: true }, true, lists(KLEIN_COMPACT_FILES))).toEqual({ preset: "general--r2-2a-klein-compact8", width: 896, height: 896 });
  });
});

describe("rules of a workflow ComfyUI has", () => {
  it("a /object_info file list in the COMBO spelling counts like the bare list", () => {
    const info = comfyInfo(ZIMAGE_FILES) as Record<string, { input: { required: Record<string, unknown> } }>;
    info["UNETLoader"]!.input.required["unet_name"] = ["COMBO", { options: ["z_image_turbo_int8_convrot.safetensors"] }];
    const listed = comfyLists(info);
    expect(listed.files["UNETLoader.unet_name"]).toEqual(["z_image_turbo_int8_convrot.safetensors"]);
    expect(ids(listPresets(listed).ready)).toContain("z-image-int8");
  });

  it("sampler and scheduler names are never taken for files, and an empty file list is the same as none", () => {
    const { files: listed } = lists(KLEIN_FILES);
    expect(Object.keys(listed).filter((key) => /sampler|scheduler/i.test(key))).toEqual([]);
    expect(listed).not.toHaveProperty(["CheckpointLoaderSimple.ckpt_name"]);
    expect(listed).toHaveProperty(["UNETLoader.unet_name"], ["flux-2-klein-4b-fp8.safetensors"]);
  });

  it("one whose files name no model family the app knows gets ComfyUI's own mark", () => {
    expect(named("sd_xl_base_1.0.safetensors")).toBe("sdxl");
    expect(named("juggernaut.safetensors")).toBe("comfy");
  });

  it("one whose files' sizes are all unknown is estimated at 10 GiB", () => {
    expect(workflowPreset({ id: "saved:mine", name: "mine", group: "Your workflows", graph: sdxlGraph() }).sizes).toEqual([{ width: 1024, height: 1024, bytes: 10 * GIB }]);
  });

  it("is never marked measured, whether it runs or is refused", () => {
    const runs = workflowPreset({ id: "saved:mine", name: "mine", group: "Your workflows", graph: sdxlGraph() });
    const refused = workflowPreset({ id: "saved:edit", name: "edit", group: "Your workflows", why: "It starts from a picture (Load Image); Image mode makes pictures from words only." });
    expect([runs.measured, refused.measured]).toEqual([false, false]);
    expect(listPresets(comfyLists(comfyInfo({ checkpoints: ["sd_xl_base_1.0.safetensors"] })), [runs]).ready.find((p) => p.id === "saved:mine")).toMatchObject({ measured: false });
  });
});

describe("the picker and a send, through the image module", () => {
  it("lists ComfyUI's templates, then the person's saved workflows, then the model files in its folders, after the app's own", async () => {
    const folder = await sdxlLoraFolder();
    const f = await engineOver({
      files: [{ loras: ["ink.safetensors"] }],
      routes: {
        "/templates/index.json": [{ templates: [{ name: "image_sdxl_simple", title: "SDXL Simple", mediaType: "image" }] }],
        "/templates/image_sdxl_simple.json": template("image_sdxl_simple"),
        "/userdata?dir=workflows&recurse=true&split=false&full_info=false": ["broken.json"],
        "/userdata/workflows%2Fbroken.json": { nodes: "not a list" },
        "/internal/folder_paths": { loras: [folder], checkpoints: [] },
      },
    });
    const listed = await f.module.presets();
    const all = ids([...listed.presets, ...listed.others ?? []]);
    const theirs = all.filter((id) => id.includes(":"));
    expect(theirs).toEqual(["template:image_sdxl_simple", "saved:broken.json", "file:loras/ink.safetensors"]);
    expect(all.slice(-theirs.length)).toEqual(theirs);
  });

  it("a pick of either Klein setup is the one Klein row the card lists, with that row's tier", async () => {
    const f = await engineOver({ files: [KLEIN_COMPACT_FILES], card: 16 * GIB, choice: { preset: "flux2-klein-4b", width: 1024, height: 1024 } });
    const listed = await f.module.presets();
    const rows = [...listed.presets, ...listed.others ?? []];
    expect(rows.filter((p) => p.id.startsWith("flux2-klein-4b")).map((p) => [p.id, p.tier])).toEqual([["flux2-klein-4b-compact", "Fast"]]);
    expect(listed.current).toMatchObject({ preset: { id: "flux2-klein-4b-compact" }, width: 1024, height: 1024 });
  });

  it("a saved ComfyUI template stays the pick, and its card names the file it is missing", async () => {
    const f = await engineOver({
      files: [SDXL_FILES],
      routes: { "/templates/index.json": [{ templates: [{ name: "image_sdxl_simple", title: "SDXL Simple", mediaType: "image" }] }], "/templates/image_sdxl_simple.json": template("image_sdxl_simple") },
      choice: { preset: "template:image_sdxl_simple", width: 1024, height: 1024 },
    });
    await f.module.presets();
    const job = await f.module.generate({ prompt: "a fox" }); await f.module.wait(job.jobId);
    expect(f.events.at(-1)).toMatchObject({ state: "error", errorKind: "image-model", choice: { preset: "template:image_sdxl_simple" }, message: "The picture model isn't installed.", detail: expect.stringMatching(/^sd_xl_base_1\.0\.safetensors belongs in .*checkpoints/) });
  });

  it("a Retry of a card made with a retired theme runs that theme again, its words around the first prompt", async () => {
    const f = await engineOver({ files: [ZIMAGE_FILES] });
    const thread = f.store.createThread();
    const portraits = { preset: "flux2-klein-4b-portraits", width: 832, height: 1216 };
    const failed = await f.module.generate({ prompt: "a fox", threadId: thread.id, choice: portraits }); await f.module.wait(failed.jobId);
    expect(f.events.at(-1)).toMatchObject({ jobId: failed.jobId, state: "error", errorKind: "image-model", choice: portraits });
    f.list([KLEIN_FILES]);
    const retry = await f.module.generate({ prompt: "ignored", threadId: thread.id, retryOf: failed.jobId }); await f.module.wait(retry.jobId);
    expect(f.events.at(-1)).toMatchObject({ jobId: retry.jobId, state: "done", choice: portraits });
    expect(f.graphs.at(-1)!["4"]!.inputs["text"]).toBe("Natural editorial portrait photograph. a fox Soft window light, realistic skin texture, clear eyes, both hands visible with relaxed separated fingers, simple uncluttered background.");
  });
});

describe("imageOffLine, every way the image tool is off", () => {
  it("says what turns it on here, and never sends the person to another app or website", () => {
    const cases: [Parameters<typeof imageOffLine>[0], boolean, boolean, string][] = [
      [{ imageGen: false }, true, true, "Turn on Generate images in Settings > Image generation."],
      [{ imageGen: true }, false, true, "Set up an image model in Settings > Image generation."],
      [{ imageGen: true }, true, false, "Turn on Let the model use tools and Make images in Settings > Tools, or switch the message box to Image."],
      [{ imageGen: true, imageTool: false }, true, true, "Turn on Make images in Settings > Tools, or switch the message box to Image."],
    ];
    for (const [settings, runnable, toolsOn, say] of cases) {
      const line = imageOffLine(settings, runnable, toolsOn);
      expect(line, say).toContain(`If asked for an image, say: "${say}"`);
      expect(line, say).toMatch(/ Never send the person to another app or website for it\.$/);
    }
  });
});
